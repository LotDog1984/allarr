// Checks upstream for newer releases of the apps whose versions are pinned in the Dockerfile
// (Seerr, Maintainerr, Wizarr, SABnzbd, Cleanuparr) and rewrites the ARG lines.
//
//   node scripts/bump-versions.mjs            rewrite Dockerfile + write bump-summary.md when something changed
//   DRY_RUN=1 node scripts/bump-versions.mjs  only print what would change
//
// Used by .github/workflows/bump-versions.yml, which opens a pull request. Nothing is built or published
// until a person merges that pull request.
import fs from 'node:fs';

const TARGETS = {
  SEERR_VERSION: 'seerr-team/seerr',
  MAINTAINERR_VERSION: 'Maintainerr/Maintainerr',
  WIZARR_VERSION: 'wizarrrr/wizarr',
  SABNZBD_VERSION: 'sabnzbd/sabnzbd',
  CLEANUPARR_VERSION: 'Cleanuparr/Cleanuparr',
};

const headers = {
  'user-agent': 'allarr-bump',
  accept: 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

const seg = (v) => v.replace(/^v/, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
const newer = (a, b) => {
  const [x, y] = [seg(a), seg(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
};

let dockerfile = fs.readFileSync('Dockerfile', 'utf8');
const changes = [];

for (const [arg, repo] of Object.entries(TARGETS)) {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) {
    console.warn(`skipping ${repo}: GitHub answered ${res.status}`);
    continue;
  }
  const rel = await res.json();
  const latest = rel.tag_name.replace(/^v/, '');
  const re = new RegExp(`^(ARG ${arg}=)(\\S+)$`, 'm');
  const m = dockerfile.match(re);
  if (!m) throw new Error(`ARG ${arg} not found in the Dockerfile`);
  console.log(`${arg.padEnd(20)} pinned ${m[2].padEnd(12)} latest ${latest}`);
  if (newer(latest, m[2])) {
    dockerfile = dockerfile.replace(re, `$1${latest}`);
    changes.push({ repo, from: m[2], to: latest, url: rel.html_url });
  }
}

if (!changes.length) {
  console.log('Everything is up to date.');
} else if (process.env.DRY_RUN) {
  console.log('Would bump:', changes.map((c) => `${c.repo} ${c.from} -> ${c.to}`).join(', '));
} else {
  fs.writeFileSync('Dockerfile', dockerfile);
  const lines = changes.map((c) => `- **${c.repo}** ${c.from} → ${c.to} ([release notes](${c.url}))`);
  fs.writeFileSync(
    'bump-summary.md',
    `Newer upstream releases are available for the apps pinned in the Dockerfile:\n\n${lines.join('\n')}\n\n` +
      '**Merging this pull request builds and publishes a new image.** If the build fails, nothing is published and ' +
      'the current `latest` image stays as it is. Check the release notes first: a new major version of an app can ' +
      'change its runtime requirements (for example the Node version) or its database.\n',
  );
  console.log(`Bumped ${changes.length} version(s); wrote bump-summary.md`);
}
