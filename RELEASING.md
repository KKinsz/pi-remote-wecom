# Releasing

This repository can be distributed as a Pi package through Git or npm. Follow the [Pi package specification](https://pi.dev/docs/latest/packages). Preparing the files does not create a public repository or publish a package.

## One checkout, two remotes

Maintain one codebase in one local checkout. Keep `origin` pointing to the existing CNB repository and add `github` for the public repository. Do not change the existing origin URL or configure multiple push URLs on it: each destination should be explicit.

```text
git remote add github https://github.com/KKinsz/pi-remote-wecom.git
```

The chosen public destination is `KKinsz/pi-remote-wecom`. If the remote already exists, inspect it with `git remote -v` rather than adding it again. A remote entry alone neither creates the hosted repository nor uploads code.

Use the same reviewed source and release version for both destinations. Do not keep internal and external feature variants. Develop changes once, run checks once for that revision, then promote the approved revision through the respective repository's review process. Bring community fixes into the same development branch before the next release. CNB and GitHub CI definitions live together; npm is built from that same reviewed release.

CNB keeps its existing development history. GitHub starts with a parentless initial commit containing the reviewed source snapshot. Later public commits have only the previous public commit as their parent. The commit IDs therefore differ, but corresponding releases must have identical Git tree IDs (the same files and modes). Never merge CNB history into the public branch. Push only the intended branch and release tag; do not use `--mirror`, `--all`, or a force push as a shortcut. Old local branches are not automatically part of a release.

## First public release

1. The public destination and npm name are `KKinsz/pi-remote-wecom` and `pi-remote-wecom`. Confirm you can create/publish them; a name lookup does not reserve either name. Keep `repository`, `homepage`, and `bugs` in `package.json` aligned, and update the publication status in both READMEs when each channel goes live. Use `git+https://github.com/KKinsz/pi-remote-wecom.git` for the repository metadata.
2. Keep `pi-package` in `keywords` so the npm package is eligible for Pi gallery discovery. Keep the explicit extension entry, production dependency list, and `files` allowlist.
3. Review the exact source snapshot, commit message, and public author identity. Build the first public commit without parents; preserve licenses and source notices but exclude untracked research and runtime files. Keep the existing CNB history intact. A current-file check does not check commit metadata or ancestors, so verify the public branch contains only the intended public commits.
4. Confirm an unused version and package name on npm, synchronize `package.json` and `package-lock.json`, and move the intended `Unreleased` changes into a dated release entry. Preserve the exact scope of real-device validation rather than claiming untested environments.
5. Run the checks below and enable the GitHub checks on the public repository. Enable private vulnerability reporting or provide an actual private maintainer contact before inviting security reports.

```sh
npm ci --ignore-scripts
npm run check
npm run test:package
npm run check:public
npm audit --omit=dev
npm pack --dry-run
```

`check:public` additionally requires public GitHub metadata and rejects internal links or local-only files from the release inputs. It checks metadata syntax and consistency, not whether the hosted repository exists or is public. The common-pattern scan is not a full credential or history audit.

## Prepare subsequent public snapshots

`codex/public-release` is a distribution branch, not a second development branch. Fixes belong in the development branch, including fixes received from community PRs. Rebuild the public snapshot from the reviewed development commit; do not merge that commit into the public branch.

For a committed, reviewed source revision, the following local-only example appends its tree to the public history without copying its ancestry. Set `SOURCE_COMMIT` to that exact commit and use the maintainer's confirmed public identity shown below. Run release checks against that source before preparing the snapshot.

```sh
source_commit=SOURCE_COMMIT
public_ref=refs/heads/codex/public-release
previous_public=$(git rev-parse "$public_ref")
source_tree=$(git rev-parse "$source_commit^{tree}")
new_public=$(GIT_AUTHOR_NAME=KKinsz \
  GIT_AUTHOR_EMAIL=50832259+KKinsz@users.noreply.github.com \
  GIT_COMMITTER_NAME=KKinsz \
  GIT_COMMITTER_EMAIL=50832259+KKinsz@users.noreply.github.com \
  git commit-tree "$source_tree" -p "$previous_public" -m "Release VERSION")
git update-ref "$public_ref" "$new_public" "$previous_public"
git diff --exit-code "$source_commit" "$public_ref" --
```

The final comparison must be empty. Use the source and public commit IDs as the release mapping. A public-only tag must point to the public commit, never to a CNB commit. Do not push local tags in bulk. Preparing a snapshot does not publish it.

## Publish the reviewed version

Once the repository and release are approved for public distribution:

1. Promote the development revision to CNB through its review process. Publish only `codex/public-release` to GitHub (for example, `git push github codex/public-release:main`) and wait for CI. Confirm its source tree matches the approved CNB revision; the commit IDs differ by design.
2. Create destination-specific version tags and releases with matching versions, changelog, and known limitations. Public tags must point into the public history. Do not reuse an internal tag for the public push, because that would publish its ancestry.
3. Authenticate to npm using your own account, confirm the package name and registry, then run `npm publish --access public`. The package's `prepublishOnly` hook reruns validation; do not bypass it with `--ignore-scripts`.
4. Verify installation from the published Git tag and npm version using an isolated Pi configuration. Only then add the npm installation command to both READMEs and announce the release to the Pi community.

Example installation syntax after the corresponding artifacts exist:

```text
pi install git:github.com/KKinsz/pi-remote-wecom@vVERSION
pi install npm:pi-remote-wecom@VERSION
```

Replace `VERSION` with the published version; these commands are only usable after the matching artifacts exist. CI validates changes only; it does not publish automatically.
