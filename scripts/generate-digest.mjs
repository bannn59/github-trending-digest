import { Octokit } from '@octokit/rest';

// --- Phase 0: Initialization ---

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('Error: GITHUB_TOKEN environment variable is not set.');
  process.exit(1);
}

const REPO_OWNER = process.env.REPO_OWNER || '996icu'; // fallback for local testing
const REPO_NAME = process.env.REPO_NAME || '996.ICU';  // fallback for local testing
const DIGEST_COUNT = parseInt(process.env.DIGEST_COUNT || '20', 10);

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const today = new Date().toISOString().split('T')[0];
const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  .toISOString()
  .split('T')[0];

console.log(`Generating digest for ${today}, fetching top ${DIGEST_COUNT} repos...`);

// --- Helper: retry with rate limit handling ---

async function callWithRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err.status === 403 || err.status === 429) && i < retries - 1) {
        const waitSeconds = err.response?.headers?.['retry-after']
          ? parseInt(err.response.headers['retry-after'], 10)
          : 60 * (i + 1);
        console.warn(`Rate limited (attempt ${i + 1}). Waiting ${waitSeconds}s...`);
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        continue;
      }
      throw err;
    }
  }
}

// --- Phase 1: Fetch Trending Repos ---

console.log(`Searching for repos with stars > 1000, pushed after ${sevenDaysAgo}...`);

const searchResult = await callWithRetry(() =>
  octokit.rest.search.repos({
    q: `stars:>1000 pushed:>${sevenDaysAgo}`,
    sort: 'stars',
    order: 'desc',
    per_page: DIGEST_COUNT,
  })
);

const repos = searchResult.data.items;
console.log(`Found ${repos.length} repos.`);

// --- Phase 2: Fetch Latest Release for Each Repo ---

const releases = {};
for (const repo of repos) {
  try {
    const { data } = await callWithRetry(() =>
      octokit.rest.repos.listReleases({
        owner: repo.owner.login,
        repo: repo.name,
        per_page: 1,
      })
    );
    releases[repo.full_name] = data[0] || null;
  } catch {
    releases[repo.full_name] = null;
  }
}
console.log('Fetched latest releases.');

// --- Phase 3: Fetch Latest 3 Commits for Each Repo ---

const commitsMap = {};
for (const repo of repos) {
  try {
    const { data } = await callWithRetry(() =>
      octokit.rest.repos.listCommits({
        owner: repo.owner.login,
        repo: repo.name,
        per_page: 3,
      })
    );
    commitsMap[repo.full_name] = data.map((c) => ({
      sha: c.sha.substring(0, 7),
      message: c.commit.message.split('\n')[0],
      date: c.commit.author.date.split('T')[0],
      url: c.html_url,
    }));
  } catch {
    commitsMap[repo.full_name] = [];
  }
}
console.log('Fetched recent commits.');

// --- Phase 4: Generate Markdown ---

function escapeCell(text) {
  if (!text) return '';
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').substring(0, 100);
}

function formatStars(n) {
  return n.toLocaleString();
}

let md = `# Daily GitHub Trending Repos Digest\n\n`;
md += `> Generated on: ${today}\n\n`;
md += `## Top ${repos.length} Trending Repositories\n\n`;
md += `| # | Repository | Stars | Language | Description |\n`;
md += `|---|-----------|-------|----------|-------------|\n`;

repos.forEach((repo, i) => {
  const desc = escapeCell(repo.description);
  md += `| ${i + 1} | [${repo.full_name}](${repo.html_url}) | ${formatStars(repo.stargazers_count)} | ${repo.language || 'N/A'} | ${desc} |\n`;
});

md += `\n---\n\n## Repository Details\n\n`;

repos.forEach((repo, i) => {
  const release = releases[repo.full_name];
  const repoCommits = commitsMap[repo.full_name] || [];

  const releaseInfo = release
    ? `[${release.tag_name}](${release.html_url}) (${release.published_at.split('T')[0]})`
    : 'None';

  md += `### ${i + 1}. [${repo.full_name}](${repo.html_url})\n\n`;
  md += `**Stars:** ${formatStars(repo.stargazers_count)} | **Language:** ${repo.language || 'N/A'} | **Latest Release:** ${releaseInfo}\n\n`;
  md += `> ${repo.description || 'No description'}\n\n`;

  if (repoCommits.length > 0) {
    md += `#### Recent Commits\n\n`;
    for (const c of repoCommits) {
      md += `- [\`${c.sha}\`](${c.url}) ${c.message} (${c.date})\n`;
    }
    md += `\n`;
  }

  md += `---\n\n`;
});

console.log('Markdown generated.');

// --- Phase 5: Write Digest File via GitHub API ---

const filePath = `digest/${today}.md`;

let existingSha = null;
try {
  const { data } = await callWithRetry(() =>
    octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
    })
  );
  existingSha = data.sha;
} catch (err) {
  if (err.status !== 404) throw err;
}

await callWithRetry(() =>
  octokit.rest.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: filePath,
    message: `Add trending repos digest for ${today}`,
    content: Buffer.from(md, 'utf-8').toString('base64'),
    sha: existingSha || undefined,
  })
);

console.log(`Digest written to ${filePath}`);

// --- Phase 6: Cleanup digests older than 30 days ---

const RETENTION_DAYS = 30;
const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  .toISOString()
  .split('T')[0];

console.log(`Cleaning up digests older than ${cutoffDate}...`);

try {
  const { data: files } = await callWithRetry(() =>
    octokit.rest.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: 'digest',
    })
  );

  const datePattern = /^(\d{4}-\d{2}-\d{2})\.md$/;
  let deletedCount = 0;

  for (const file of files) {
    const match = file.name.match(datePattern);
    if (!match) continue;

    const fileDate = match[1];
    if (fileDate >= cutoffDate) continue;

    try {
      await callWithRetry(() =>
        octokit.rest.repos.deleteFile({
          owner: REPO_OWNER,
          repo: REPO_NAME,
          path: `digest/${file.name}`,
          message: `Cleanup: remove digest ${file.name} (older than ${RETENTION_DAYS} days)`,
          sha: file.sha,
        })
      );
      deletedCount++;
      console.log(`  Deleted ${file.name}`);
    } catch (err) {
      console.warn(`  Failed to delete ${file.name}: ${err.message}`);
    }
  }

  console.log(`Cleanup done. Deleted ${deletedCount} old digest(s).`);
} catch (err) {
  console.warn(`Cleanup skipped: ${err.message}`);
}
