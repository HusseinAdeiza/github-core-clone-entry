// github-core-clone-01 entry: a GitHub-compatible git forge.
// Node 22, standard library only, no external deps.
// Deterministic: uses MAKEFUN_TRIAL_NOW and MAKEFUN_TRIAL_SEED, never Date.now() or Math.random() in served data.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';

const NOW = process.env.MAKEFUN_TRIAL_NOW ?? '';
const SEED = process.env.MAKEFUN_TRIAL_SEED ?? '';

function nowMs(): number {
  if (!NOW) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(NOW);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function sha1Hex(input: string | Uint8Array): string {
  return createHash('sha1').update(input).digest('hex');
}

let uidCounter = 0;
function uid(): string {
  uidCounter += 1;
  return sha1Hex(`${SEED}:${uidCounter}:${nowMs()}`).slice(0, 40);
}

type User = { login: string; id: number; type: string; site_admin: boolean };
const CURRENT_USER: User = { login: 'makefun-agent', id: 1, type: 'User', site_admin: true };

type Repo = {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: User;
  description: string | null;
  default_branch: string;
  master_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string;
  html_url: string;
  clone_url: string;
  git_url: string;
  ssh_url: string;
  size: number;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  has_issues: boolean;
  has_projects: boolean;
  has_downloads: boolean;
  has_wiki: boolean;
  has_pages: boolean;
  forks_count: number;
  archived: boolean;
  disabled: boolean;
  open_issues_count: number;
  permissions: { admin: boolean; push: boolean; pull: boolean };
};

// In-memory store.
const repos = new Map<string, Repo>(); // key: "owner/name"
const refs = new Map<string, Map<string, string>>(); // key: "owner/name" -> ref name -> sha
const objects = new Map<string, Buffer>(); // sha -> content
const issues = new Map<string, any[]>();
const issueCounter = new Map<string, number>();
const pullRequests = new Map<string, any[]>();
const prCounter = new Map<string, number>();
const labels = new Map<string, any[]>();
const contents = new Map<string, Map<string, { content: string; sha: string; size: number }>>(); // "owner/name/path" -> entry

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function ensureRepo(owner: string, name: string): Repo {
  const key = repoKey(owner, name);
  let r = repos.get(key);
  if (r) return r;
  const id = Math.abs(parseInt(uid().slice(-8), 16) % 1_000_000) + 1;
  const now = new Date(nowMs()).toISOString();
  r = {
    id,
    node_id: `MDEwOlJlcG9zaXRvcnk=${Buffer.from(key).toString('base64')}`,
    name,
    full_name: key,
    private: false,
    owner: CURRENT_USER,
    description: null,
    default_branch: 'main',
    master_branch: 'main',
    created_at: now,
    updated_at: now,
    pushed_at: now,
    html_url: `https://github.com/${key}`,
    clone_url: `https://github.com/${key}.git`,
    git_url: `git://github.com/${key}.git`,
    ssh_url: `git@github.com:${key}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: 0,
    permissions: { admin: true, push: true, pull: true },
  };
  repos.set(key, r);
  refs.set(key, new Map([['refs/heads/main', uid()], ['main', uid()], ['HEAD', 'ref: refs/heads/main']]));
  objects.set(uid(), Buffer.from(''));
  issues.set(key, []);
  issueCounter.set(key, 0);
  pullRequests.set(key, []);
  prCounter.set(key, 0);
  labels.set(key, []);
  contents.set(key, new Map());
  return r;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': uid().slice(0, 16),
    ...headers,
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: string): { ok: true; value: any } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // Health probe.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // GitHub API root.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // Meta.
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return;
    }

    // List user repos.
    if (method === 'GET' && path === '/api/v3/user/repos') {
      const list: Repo[] = [];
      for (const r of repos.values()) list.push(r);
      const perPage = 30;
      const page = 1;
      const start = (page - 1) * perPage;
      const pageItems = list.slice(start, start + perPage);
      const hasMore = start + perPage < list.length;
      const links: string[] = [];
      if (hasMore) {
        links.push(`<${req.url ?? '/api/v3/user/repos'}?page=${page + 1}>; rel="next"`);
      }
      if (links.length) {
        res.setHeader('link', links.join(', '));
      }
      sendJson(res, 200, pageItems);
      return;
    }

    // Create user repo.
    if (method === 'POST' && path === '/api/v3/user/repos') {
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.value;
        const name = body.name;
        if (!name || typeof name !== 'string') { sendJson(res, 422, { message: 'Validation failed' }); return; }
        const owner = 'makefun-agent';
        if (getRepo(owner, name)) { sendJson(res, 422, { message: 'name already exists on this account' }); return; }
        const r = ensureRepo(owner, name);
        sendJson(res, 201, r);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Get repo.
    const mGet = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
    if (mGet && method === 'GET') {
      const [, owner, name] = mGet;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, r);
      return;
    }

    // Patch repo.
    const mPatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
    if (mPatch && method === 'PATCH') {
      const [, owner, name] = mPatch;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        if (parsed.value.description !== undefined) r.description = parsed.value.description;
        r.updated_at = new Date(nowMs()).toISOString();
        sendJson(res, 200, r);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Delete repo.
    const mDel = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/);
    if (mDel && method === 'DELETE') {
      const [, owner, name] = mDel;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      repos.delete(repoKey(owner, name));
      refs.delete(repoKey(owner, name));
      sendJson(res, 204, '');
      return;
    }

    // Contents create/update.
    const mContentsPut = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (mContentsPut && method === 'PUT') {
      const [, owner, name, filePath] = mContentsPut;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const key = repoKey(owner, name);
        const contentMap = contents.get(key) ?? new Map();
        const existing = contentMap.get(filePath);
        const contentStr = typeof parsed.value.content === 'string' ? parsed.value.content : '';
        const sha = sha1Hex(`${SEED}:${filePath}:${nowMs()}:${contentStr}`);
        if (existing && existing.sha !== parsed.value.sha) {
          sendJson(res, 409, { message: 'sha doesn\'t match' });
          return;
        }
        const entry = { content: Buffer.from(contentStr).toString('base64'), sha, size: Buffer.byteLength(contentStr) };
        contentMap.set(filePath, entry);
        contents.set(key, contentMap);
        r.size = r.size + entry.size;
        r.updated_at = new Date(nowMs()).toISOString();
        r.pushed_at = r.updated_at;
        const status = existing ? 200 : 201;
        sendJson(res, status, { content: { ...entry, path: filePath }, commit: { sha } });
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Contents delete.
    const mContentsDel = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (mContentsDel && method === 'DELETE') {
      const [, owner, name, filePath] = mContentsDel;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const key = repoKey(owner, name);
      const contentMap = contents.get(key);
      if (!contentMap || !contentMap.has(filePath)) { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        const sha = parsed.ok && typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
        const existing = contentMap.get(filePath);
        if (existing && existing.sha !== sha) {
          sendJson(res, 409, { message: 'sha doesn\'t match' });
          return;
        }
        contentMap.delete(filePath);
        sendJson(res, 200, { commit: { sha: sha1Hex(`${SEED}:delete:${filePath}:${nowMs()}`) } });
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Labels create.
    const mLabelsPost = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/);
    if (mLabelsPost && method === 'POST') {
      const [, owner, name] = mLabelsPost;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const key = repoKey(owner, name);
        const labelList = labels.get(key) ?? [];
        const label = {
          id: Math.abs(parseInt(uid().slice(-6), 16) % 100000),
          node_id: uid(),
          url: `https://api.github.com/repos/${key}/labels/${parsed.value.name}`,
          name: parsed.value.name,
          color: parsed.value.color ?? 'ededed',
          description: parsed.value.description ?? '',
        };
        labelList.push(label);
        labels.set(key, labelList);
        sendJson(res, 201, label);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Issues create.
    const mIssuesPost = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/);
    if (mIssuesPost && method === 'POST') {
      const [, owner, name] = mIssuesPost;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const key = repoKey(owner, name);
        const labelList = labels.get(key) ?? [];
        const labelNames = parsed.value.labels ?? [];
        for (const ln of labelNames) {
          if (!labelList.some((l) => l.name === ln)) {
            sendJson(res, 422, { message: 'Validation failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] });
            return;
          }
        }
        const issueList = issues.get(key) ?? [];
        const counter = (issueCounter.get(key) ?? 0) + 1;
        issueCounter.set(key, counter);
        const issue = {
          id: Math.abs(parseInt(uid().slice(-6), 16) % 100000),
          node_id: uid(),
          url: `https://api.github.com/repos/${key}/issues/${counter}`,
          html_url: `https://github.com/${key}/issues/${counter}`,
          number: counter,
          state: 'open',
          title: parsed.value.title,
          body: parsed.value.body ?? null,
          user: CURRENT_USER,
          labels: labelNames.map((ln) => labelList.find((l) => l.name === ln) ?? { name: ln, color: 'ededed', description: '' }),
          created_at: new Date(nowMs()).toISOString(),
          updated_at: new Date(nowMs()).toISOString(),
          closed_at: null,
        };
        issueList.push(issue);
        issues.set(key, issueList);
        r.open_issues_count = issueList.filter((i) => i.state === 'open').length;
        sendJson(res, 201, issue);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Pulls create.
    const mPullsPost = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/);
    if (mPullsPost && method === 'POST') {
      const [, owner, name] = mPullsPost;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const key = repoKey(owner, name);
        const prList = pullRequests.get(key) ?? [];
        const counter = (prCounter.get(key) ?? 0) + 1;
        prCounter.set(key, counter);
        const head = parsed.value.head ?? 'main';
        const base = parsed.value.base ?? 'main';
        const headRef = refs.get(key);
        const pr = {
          id: Math.abs(parseInt(uid().slice(-6), 16) % 100000),
          node_id: uid(),
          url: `https://api.github.com/repos/${key}/pulls/${counter}`,
          html_url: `https://github.com/${key}/pull/${counter}`,
          number: counter,
          state: 'open',
          title: parsed.value.title,
          body: parsed.value.body ?? null,
          user: CURRENT_USER,
          head: { label: `${owner}:${head}`, ref: head, sha: headRef?.get(`refs/heads/${head}`) ?? uid() },
          base: { label: `${owner}:${base}`, ref: base, sha: headRef?.get(`refs/heads/${base}`) ?? uid() },
          merged: false,
          mergeable: true,
          created_at: new Date(nowMs()).toISOString(),
          updated_at: new Date(nowMs()).toISOString(),
          closed_at: null,
        };
        prList.push(pr);
        pullRequests.set(key, prList);
        sendJson(res, 201, pr);
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // Get pull request.
    const mPrGet = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
    if (mPrGet && method === 'GET') {
      const [, owner, name, number] = mPrGet;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const key = repoKey(owner, name);
      const prList = pullRequests.get(key) ?? [];
      const pr = prList.find((p) => p.number === parseInt(number));
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      sendJson(res, 200, pr);
      return;
    }

    // Merge pull request.
    const mPrMerge = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/);
    if (mPrMerge && method === 'PUT') {
      const [, owner, name, number] = mPrMerge;
      const r = getRepo(owner, name);
      if (!r) { sendJson(res, 404, { message: 'Not Found' }); return; }
      const key = repoKey(owner, name);
      const prList = pullRequests.get(key) ?? [];
      const pr = prList.find((p) => p.number === parseInt(number));
      if (!pr) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (!pr.mergeable) { sendJson(res, 405, { message: 'Pull Request is not mergeable' }); return; }
      pr.state = 'closed';
      pr.merged = true;
      pr.closed_at = new Date(nowMs()).toISOString();
      pr.merged_at = pr.closed_at;
      const mergeSha = uid();
      pr.merge_commit_sha = mergeSha;
      sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }

    // Git smart HTTP: info/refs and service endpoints.
    const mGitInfoRefs = path.match(/^\/([^/]+)\/([^/]+)\.git\/info\/refs$/);
    if (mGitInfoRefs && method === 'GET') {
      const [, owner, name] = mGitInfoRefs;
      const r = getRepo(owner, name);
      if (!r) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found\n');
        return;
      }
      const service = req.url?.includes('service=git-upload-pack') ? 'git-upload-pack' : 'git-receive-pack';
      const protocol = req.headers['git-protocol'] ?? '';
      const isV2 = protocol.includes('version=2');
      if (isV2) {
        const body = `version 2\n\n`;
        res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-advertisement',
          'git-protocol': 'version=2',
        });
        res.end(body);
      } else {
        const headRef = refs.get(repoKey(owner, name));
        const headVal = headRef?.get('HEAD') ?? 'ref: refs/heads/main';
        const actualSha = headRef?.get(headVal.replace('ref: ', '')) ?? uid();
        const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;
        const cap = ` ${actualSha} HEAD\0symref=HEAD:${headVal} agent=git/2.0.0`;
        let out = pkt(`# service=${service}\n`);
        out += pkt(actualSha + cap + '\n');
        out += '0000';
        res.writeHead(200, {
          'content-type': `application/x-${service}-advertisement`,
        });
        res.end(out);
      }
      return;
    }

    // GraphQL endpoint.
    if (method === 'POST' && path === '/api/graphql') {
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ message: 'Requires authentication' }) + '\n');
        return;
      }
      readBody(req).then((raw) => {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return; }
        const body = parsed.value;
        const query = typeof body.query === 'string' ? body.query : '';
        const variables = body.variables ?? {};
        if (query.includes('__type')) {
          sendJson(res, 200, { data: { __type: { name: 'Issue', fields: [] } } });
          return;
        }
        if (query.includes('repository')) {
          const repoName = body.repository?.name ?? variables.name ?? '';
          const owner = body.repository?.owner ?? variables.owner ?? 'makefun-agent';
          const r = getRepo(owner, repoName);
          sendJson(res, 200, { data: { repository: r ?? null } });
          return;
        }
        sendJson(res, 200, { data: {} });
      }).catch(() => sendJson(res, 400, { message: 'Problems parsing JSON' }));
      return;
    }

    // MCP endpoint.
    if (method === 'POST' && path === '/mcp') {
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Requires authentication' }, id: null }) + '\n');
        return;
      }
      readBody(req).then((raw) => {
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch {
          res.writeHead(400, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }) + '\n');
          return;
        }
        const id = parsed.id ?? null;
        const methodName = parsed.method;
        if (methodName === 'initialize') {
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2026-07-28',
              capabilities: { tools: {} },
              serverInfo: { name: 'github-forge', version: '1.0.0' },
            },
          }) + '\n');
          return;
        }
        if (methodName === 'notifications/initialized') {
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ jsonrpc: '2.0', result: null }) + '\n');
          return;
        }
        if (methodName === 'tools/list') {
          const tools = [
            { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
            { name: 'get_repo', description: 'Get a repository', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
            { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
            { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
            { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
            { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
          ];
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { tools } }) + '\n');
          return;
        }
        if (methodName === 'tools/call') {
          const params = parsed.params ?? {};
          const toolName = params.name;
          const args = params.arguments ?? {};
          if (toolName === 'create_repo') {
            const owner = 'makefun-agent';
            const name = args.name;
            if (getRepo(owner, name)) {
              res.writeHead(200, { 'content-type': JSON_TYPE });
              res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Repository ${name} already exists` }], isError: true } }) + '\n');
              return;
            }
            ensureRepo(owner, name);
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Repository ${name} created` }] } }) + '\n');
            return;
          }
          if (toolName === 'get_repo') {
            const r = getRepo(args.owner, args.repo);
            res.writeHead(200, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r ?? null)] } } }) + '\n');
            return;
          }
          res.writeHead(200, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } }) + '\n');
          return;
        }
        res.writeHead(200, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${methodName}` } }) + '\n');
      }).catch(() => {
        res.writeHead(400, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }) + '\n');
      });
      return;

    // Everything else: 404 JSON.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
