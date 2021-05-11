import * as core from "@actions/core";
import { exec as _exec } from "@actions/exec";
import { context, GitHub } from "@actions/github";
import semver, { ReleaseType } from "semver";
import { analyzeCommits } from "./myCommitAnalyzer";
import { generateNotes } from "@semantic-release/release-notes-generator";

const SEPARATOR = "==============================================";

async function exec(command: string, args?: string[]) {
  let stdout = "";
  let stderr = "";

  try {
    const options = {
      listeners: {
        stdout: (data: Buffer) => {
          stdout += data.toString();
        },
        stderr: (data: Buffer) => {
          stderr += data.toString();
        }
      }
    };

    const code = await _exec(command, args, options);

    return {
      code,
      stdout,
      stderr
    };
  } catch (err) {
    return {
      code: 1,
      stdout,
      stderr,
      error: err
    };
  }
}

export async function run() {
  try {
    const defaultBump = core.getInput("default_bump") as ReleaseType;
    const messageParserPreset = core.getInput("message_parser_preset");
    const tagPrefix = core.getInput("tag_prefix");
    const releaseBranches = core.getInput("release_branches");
    const createAnnotatedTag = core.getInput("create_annotated_tag");
    const dryRun = core.getInput("dry_run");

    const { GITHUB_REF, GITHUB_SHA } = process.env;

    if (!GITHUB_REF) {
      core.setFailed("Missing GITHUB_REF");
      return;
    }

    if (!GITHUB_SHA) {
      core.setFailed("Missing GITHUB_SHA");
      return;
    }

    const preRelease = releaseBranches
      .split(",")
      .every(branch => !GITHUB_REF.replace("refs/heads/", "").match(branch));

    // if directory is shallow, unshallow it
    const shallow = (await exec("git rev-parse --is-shallow-repository")).stdout.trim();
    if (shallow.match("true")) {
      await exec("git fetch --unshallow");
    }

    // fetch tags
    await exec("git fetch --tags");

    const hasTag = !!(await exec("git tag")).stdout.trim();
    let tag = "";
    let logs = "";

    if (hasTag) {
      console.log(await exec('pwd'));
      const previousTagSha = (
        await exec(`git rev-list --tags=${tagPrefix}* --topo-order --max-count=1`)
      ).stdout.trim();
      tag = (await exec(`git describe --tags ${previousTagSha}`)).stdout.trim();
      logs = (
        await exec(
          `git log ${tag}..HEAD --pretty=format:'%s%n%b${SEPARATOR}' --abbrev-commit`
        )
      ).stdout.trim();

      if (previousTagSha === GITHUB_SHA) {
        core.debug("No new commits since previous tag. Skipping...");
        core.setOutput("previous_tag", tag);
        return;
      }
    } else {
      tag = "0.0.0";
      logs = (
        await exec(
          `git log --pretty=format:'%s%n%b${SEPARATOR}' --abbrev-commit`
        )
      ).stdout.trim();
      core.setOutput("previous_tag", tag);
    }

    console.info(`Current tag is ${tag}`);

    // for some reason the commits start with a `'` on the CI so we ignore it
    const commits = logs
      .split(SEPARATOR)
      .map(x => ({ message: x.trim().replace(/(^['\s]+)|(['\s]+$)/g, "") }))
      .filter(x => !!x.message);

    core.debug(`Commits: ${commits}`);

    var bump = await analyzeCommits(
      { preset: messageParserPreset || 'conventionalcommits' },
      { commits, logger: { log: console.info.bind(console) } }
    ) as ReleaseType;
    core.debug(`Bump type from commits: ${bump}`);

    bump = bump || defaultBump;

    core.info(`Effective bump type: ${bump}`);

    if (!bump) {
      core.setFailed(`Nothing to bump - not building release`);
      return;
    }

    const rawVersion = tag.replace(tagPrefix, '');
    const incResult = semver.inc(rawVersion, bump || defaultBump);
    core.debug(`SemVer.inc(${rawVersion}, ${bump || defaultBump}): ${incResult}`);
    if (!incResult) {
      core.setFailed(`SemVer inc rejected tag ${tag}`);
      return;
    }

    const newVersion = `${incResult}${preRelease ? `-${GITHUB_SHA.slice(0, 7)}` : ""}`;
    const newTag = `${tagPrefix}${newVersion}`;

    core.setOutput("new_version", newVersion);
    core.setOutput("new_tag", newTag);

    core.debug(`New tag: ${newTag}`);

    const changelog = await generateNotes(
      {},
      {
        commits,
        logger: { log: console.info.bind(console) },
        options: {
          repositoryUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}`
        },
        lastRelease: { gitTag: tag },
        nextRelease: { gitTag: newTag, version: newVersion }
      }
    );

    core.setOutput("changelog", changelog);

    if (preRelease) {
      core.debug(
        "This branch is not a release branch. Skipping the tag creation."
      );
      return;
    }

    const tagAlreadyExists = !!(
      await exec(`git tag -l "${newTag}"`)
    ).stdout.trim();

    if (tagAlreadyExists) {
      core.debug("This tag already exists. Skipping the tag creation.");
      return;
    }

    core.info("dry_run: " + dryRun + " (" + typeof (dryRun) + ")");
    if (dryRun === "true") {
      core.setOutput("dry_run", "true");
      core.info("Dry run: not performing tag action.");
      return;
    }

    const octokit = new GitHub(core.getInput("github_token"));

    if (createAnnotatedTag === "true") {
      core.debug(`Creating annotated tag`);

      const tagCreateResponse = await octokit.git.createTag({
        ...context.repo,
        tag: newTag,
        message: newTag,
        object: GITHUB_SHA,
        type: "commit"
      });

      core.debug(`Pushing annotated tag to the repo`);

      await octokit.git.createRef({
        ...context.repo,
        ref: `refs/tags/${newTag}`,
        sha: tagCreateResponse.data.sha
      });
      return;
    }

    core.debug(`Pushing new tag to the repo`);

    await octokit.git.createRef({
      ...context.repo,
      ref: `refs/tags/${newTag}`,
      sha: GITHUB_SHA
    });

	// fetch tags (again)
	core.info("Fetching generated tag");
	await exec("git fetch --tags");
  } catch (error) {
    core.setFailed(error.message);
  }
}
