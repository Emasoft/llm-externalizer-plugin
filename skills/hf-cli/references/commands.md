# Full `hf` Command Reference

## Table of Contents

- [Top-level commands](#top-level-commands)
- [hf auth](#hf-auth--manage-authentication)
- [hf buckets](#hf-buckets--commands-to-interact-with-buckets)
- [hf cache](#hf-cache--manage-local-cache-directory)
- [hf collections](#hf-collections--interact-with-collections-on-the-hub)
- [hf datasets](#hf-datasets--interact-with-datasets-on-the-hub)
- [hf discussions](#hf-discussions--manage-discussions-and-pull-requests-on-the-hub)
- [hf endpoints](#hf-endpoints--manage-hugging-face-inference-endpoints)
- [hf extensions](#hf-extensions--manage-hf-cli-extensions)
- [hf jobs](#hf-jobs--run-and-manage-jobs-on-the-hub)
- [hf models](#hf-models--interact-with-models-on-the-hub)
- [hf papers](#hf-papers--interact-with-papers-on-the-hub)
- [hf repos](#hf-repos--manage-repos-on-the-hub)
- [hf skills](#hf-skills--manage-skills-for-ai-assistants)
- [hf spaces](#hf-spaces--interact-with-spaces-on-the-hub)
- [hf webhooks](#hf-webhooks--manage-webhooks-on-the-hub)
- [Common options](#common-options)
- [Mounting repos as local filesystems (`hf-mount`)](#mounting-repos-as-local-filesystems-hf-mount)
- [Tips](#tips)

The Hugging Face Hub CLI tool `hf` replaces the deprecated `huggingface-cli` command. Use `hf --help` for help; auth commands are under `hf auth` (e.g. `hf auth whoami`). Generated with `huggingface_hub v1.14.0`. Run `hf skills add --force` to regenerate.

## Top-level commands

- `hf download REPO_ID` — Download files from the Hub. `[--type CHOICE --revision TEXT --include TEXT --exclude TEXT --cache-dir TEXT --local-dir TEXT --force-download --dry-run --max-workers INTEGER --format CHOICE]`
- `hf env` — Print information about the environment. `[--format CHOICE]`
- `hf sync` — Sync files between local directory and a bucket. `[--delete --ignore-times --ignore-sizes --plan TEXT --apply TEXT --dry-run --include TEXT --exclude TEXT --filter-from TEXT --existing --ignore-existing --verbose --format CHOICE]`
- `hf update` — Update the `hf` CLI to the latest version. `[--format CHOICE]`
- `hf upload REPO_ID` — Upload a file or a folder. Recommended for single-commit uploads. `[--type CHOICE --revision TEXT --private --include TEXT --exclude TEXT --delete TEXT --commit-message TEXT --commit-description TEXT --create-pr --every FLOAT --format CHOICE]`
- `hf upload-large-folder REPO_ID LOCAL_PATH` — Upload a large folder. Recommended for resumable uploads. `[--type CHOICE --revision TEXT --private --include TEXT --exclude TEXT --num-workers INTEGER --no-report --no-bars --format CHOICE]`
- `hf version` — Print information about the hf version. `[--format CHOICE]`

## `hf auth` — Manage authentication

- `hf auth list` — List all stored access tokens. `[--format CHOICE]`
- `hf auth login` — Login using a token from huggingface.co/settings/tokens. `[--add-to-git-credential --force --format CHOICE]`
- `hf auth logout` — Logout from a specific token. `[--token-name TEXT --format CHOICE]`
- `hf auth switch` — Switch between access tokens. `[--token-name TEXT --add-to-git-credential --format CHOICE]`
- `hf auth token` — Print the current access token to stdout. `[--format CHOICE]`
- `hf auth whoami` — Find out which huggingface.co account you are logged in as. `[--format CHOICE]`

## `hf buckets` — Commands to interact with buckets

- `hf buckets cp SRC` — Copy files to or from buckets.
- `hf buckets create BUCKET_ID` — Create a new bucket. `[--private --exist-ok --format CHOICE]`
- `hf buckets delete BUCKET_ID` — Delete a bucket. `[--yes --missing-ok --format CHOICE]`
- `hf buckets info BUCKET_ID` — Get info about a bucket.
- `hf buckets list` — List buckets or files in a bucket. `[--human-readable --tree --recursive --search TEXT --format CHOICE]`
- `hf buckets move FROM_ID TO_ID` — Move (rename) a bucket.
- `hf buckets remove ARGUMENT` — Remove files from a bucket. `[--recursive --yes --dry-run --include TEXT --exclude TEXT --format CHOICE]`
- `hf buckets sync` — Sync files between local directory and a bucket. `[--delete --ignore-times --ignore-sizes --plan TEXT --apply TEXT --dry-run --include TEXT --exclude TEXT --filter-from TEXT --existing --ignore-existing --verbose --format CHOICE]`

## `hf cache` — Manage local cache directory

- `hf cache list` — List cached repositories or revisions. `[--cache-dir TEXT --revisions --filter TEXT --sort CHOICE --limit INTEGER --format CHOICE]`
- `hf cache prune` — Remove detached revisions from the cache. `[--cache-dir TEXT --yes --dry-run --format CHOICE]`
- `hf cache rm TARGETS` — Remove cached repositories or revisions. `[--cache-dir TEXT --yes --dry-run --format CHOICE]`
- `hf cache verify REPO_ID` — Verify checksums for a single repo revision from cache or a local directory. `[--type CHOICE --revision TEXT --cache-dir TEXT --local-dir TEXT --fail-on-missing-files --fail-on-extra-files --format CHOICE]`

## `hf collections` — Interact with collections on the Hub

- `hf collections add-item COLLECTION_SLUG ITEM_ID ITEM_TYPE` — Add an item to a collection. `[--note TEXT --exists-ok --format CHOICE]`
- `hf collections create TITLE` — Create a new collection. `[--namespace TEXT --description TEXT --private --exists-ok --format CHOICE]`
- `hf collections delete COLLECTION_SLUG` — Delete a collection. `[--missing-ok --format CHOICE]`
- `hf collections delete-item COLLECTION_SLUG ITEM_OBJECT_ID` — Delete an item from a collection. `[--missing-ok --format CHOICE]`
- `hf collections info COLLECTION_SLUG` — Get info about a collection.
- `hf collections list` — List collections. `[--owner TEXT --item TEXT --sort CHOICE --limit INTEGER --format CHOICE]`
- `hf collections update COLLECTION_SLUG` — Update a collection's metadata. `[--title TEXT --description TEXT --position INTEGER --private --theme TEXT --format CHOICE]`
- `hf collections update-item COLLECTION_SLUG ITEM_OBJECT_ID` — Update an item in a collection. `[--note TEXT --position INTEGER --format CHOICE]`

## `hf datasets` — Interact with datasets on the Hub

- `hf datasets card DATASET_ID` — Get the dataset card. `[--metadata --text --format CHOICE]`
- `hf datasets info DATASET_ID` — Get info about a dataset. `[--revision TEXT --expand TEXT --format CHOICE]`
- `hf datasets leaderboard DATASET_ID` — List model scores from a dataset leaderboard. Use `hf datasets ls --filter benchmark:official` to list available leaderboards. `[--limit INTEGER --format CHOICE]`
- `hf datasets list` — List datasets or files in a dataset repo. `[--search TEXT --author TEXT --filter TEXT --sort CHOICE --limit INTEGER --expand TEXT --human-readable --tree --recursive --revision TEXT --format CHOICE]`
- `hf datasets parquet DATASET_ID` — List parquet file URLs available for a dataset. `[--subset TEXT --split TEXT --format CHOICE]`
- `hf datasets sql SQL` — Execute a raw SQL query with DuckDB against dataset parquet URLs.

## `hf discussions` — Manage discussions and pull requests on the Hub

- `hf discussions close REPO_ID NUM` — Close. `[--comment TEXT --yes --type CHOICE --format CHOICE]`
- `hf discussions comment REPO_ID NUM` — Comment. `[--body TEXT --body-file PATH --type CHOICE --format CHOICE]`
- `hf discussions create REPO_ID --title TEXT` — Create new. `[--body TEXT --body-file PATH --pull-request --type CHOICE --format CHOICE]`
- `hf discussions diff REPO_ID NUM` — Show the diff of a pull request.
- `hf discussions info REPO_ID NUM` — Get info.
- `hf discussions list REPO_ID` — List. `[--status CHOICE --kind CHOICE --author TEXT --limit INTEGER --type CHOICE --format CHOICE]`
- `hf discussions merge REPO_ID NUM` — Merge a pull request. `[--comment TEXT --yes --type CHOICE --format CHOICE]`
- `hf discussions rename REPO_ID NUM NEW_TITLE` — Rename.
- `hf discussions reopen REPO_ID NUM` — Reopen. `[--comment TEXT --yes --type CHOICE --format CHOICE]`

## `hf endpoints` — Manage Hugging Face Inference Endpoints

- `hf endpoints catalog deploy --repo TEXT` — Deploy from the Model Catalog. `[--name TEXT --accelerator TEXT --namespace TEXT --format CHOICE]`
- `hf endpoints catalog list` — List available Catalog models.
- `hf endpoints delete NAME` — Delete an Inference Endpoint. `[--namespace TEXT --yes --format CHOICE]`
- `hf endpoints deploy NAME --repo TEXT --framework TEXT --accelerator TEXT --instance-size TEXT --instance-type TEXT --region TEXT --vendor TEXT` — Deploy from Hub repo. `[--namespace TEXT --task TEXT --min-replica INTEGER --max-replica INTEGER --scale-to-zero-timeout INTEGER --scaling-metric CHOICE --scaling-threshold FLOAT --format CHOICE]`
- `hf endpoints describe NAME` — Get information about an existing endpoint. `[--namespace TEXT --format CHOICE]`
- `hf endpoints list` — Lists all Inference Endpoints. `[--namespace TEXT --format CHOICE]`
- `hf endpoints pause NAME` — Pause.
- `hf endpoints resume NAME` — Resume. `[--namespace TEXT --fail-if-already-running --format CHOICE]`
- `hf endpoints scale-to-zero NAME` — Scale to zero.
- `hf endpoints update NAME` — Update existing endpoint. `[--namespace TEXT --repo TEXT --accelerator TEXT --instance-size TEXT --instance-type TEXT --framework TEXT --revision TEXT --task TEXT --min-replica INTEGER --max-replica INTEGER --scale-to-zero-timeout INTEGER --scaling-metric CHOICE --scaling-threshold FLOAT --format CHOICE]`

## `hf extensions` — Manage hf CLI extensions

- `hf extensions exec NAME` — Execute installed extension.
- `hf extensions install REPO_ID` — Install from a public GitHub repository. `[--force --format CHOICE]`
- `hf extensions list` — List installed extension commands.
- `hf extensions remove NAME` — Remove installed extension.
- `hf extensions search` — Search extensions on GitHub (tagged `hf-extension`).

## `hf jobs` — Run and manage Jobs on the Hub

- `hf jobs cancel JOB_ID` — Cancel a Job. `[--namespace TEXT --format CHOICE]`
- `hf jobs hardware` — List available hardware options for Jobs.
- `hf jobs inspect JOB_IDS` — Display detailed information on one or more Jobs.
- `hf jobs logs JOB_ID` — Fetch the logs. `[--follow --tail INTEGER --namespace TEXT --format CHOICE]`
- `hf jobs ps` — List Jobs. `[--all --namespace TEXT --filter TEXT --format TEXT --quiet]`
- `hf jobs run IMAGE COMMAND` — Run a Job. `[--env TEXT --secrets TEXT --label TEXT --volume TEXT --env-file TEXT --secrets-file TEXT --flavor CHOICE --timeout TEXT --detach --namespace TEXT]`
- `hf jobs scheduled delete SCHEDULED_JOB_ID` — Delete a scheduled Job.
- `hf jobs scheduled inspect SCHEDULED_JOB_IDS` — Display detailed information.
- `hf jobs scheduled ps` — List scheduled Jobs.
- `hf jobs scheduled resume SCHEDULED_JOB_ID` — Resume.
- `hf jobs scheduled run SCHEDULE IMAGE COMMAND` — Schedule a Job. `[--suspend --concurrency --env TEXT --secrets TEXT --label TEXT --volume TEXT --env-file TEXT --secrets-file TEXT --flavor CHOICE --timeout TEXT --namespace TEXT]`
- `hf jobs scheduled suspend SCHEDULED_JOB_ID` — Suspend.
- `hf jobs scheduled uv run SCHEDULE SCRIPT` — Run a UV script. `[--suspend --concurrency --image TEXT --flavor CHOICE --env TEXT --secrets TEXT --label TEXT --volume TEXT --env-file TEXT --secrets-file TEXT --timeout TEXT --namespace TEXT --with TEXT --python TEXT]`
- `hf jobs stats` — Fetch resource usage statistics.
- `hf jobs uv run SCRIPT` — Run a UV script (local file or URL) on HF infrastructure. `[--image TEXT --flavor CHOICE --env TEXT --secrets TEXT --label TEXT --volume TEXT --env-file TEXT --secrets-file TEXT --timeout TEXT --detach --namespace TEXT --with TEXT --python TEXT]`

## `hf models` — Interact with models on the Hub

- `hf models card MODEL_ID` — Get the model card (README). `[--metadata --text --format CHOICE]`
- `hf models info MODEL_ID` — Get info about a model. `[--revision TEXT --expand TEXT --format CHOICE]`
- `hf models list` — List models or files in a model repo. `[--search TEXT --author TEXT --filter TEXT --num-parameters TEXT --sort CHOICE --limit INTEGER --expand TEXT --human-readable --tree --recursive --revision TEXT --format CHOICE]`

## `hf papers` — Interact with papers on the Hub

- `hf papers info PAPER_ID` — Get info.
- `hf papers list` — List daily papers. `[--date TEXT --week TEXT --month TEXT --submitter TEXT --sort CHOICE --limit INTEGER --format CHOICE]`
- `hf papers read PAPER_ID` — Read a paper as markdown.
- `hf papers search QUERY` — Search papers. `[--limit INTEGER --format CHOICE]`

## `hf repos` — Manage repos on the Hub

- `hf repos branch create REPO_ID BRANCH` — Create a new branch. `[--revision TEXT --type CHOICE --exist-ok --format CHOICE]`
- `hf repos branch delete REPO_ID BRANCH` — Delete a branch.
- `hf repos create REPO_ID` — Create a new repo. `[--type CHOICE --space-sdk TEXT --private --public --protected --exist-ok --resource-group-id TEXT --flavor CHOICE --storage CHOICE --sleep-time INTEGER --secrets TEXT --secrets-file TEXT --env TEXT --env-file TEXT --volume TEXT --format CHOICE]`
- `hf repos delete REPO_ID` — Delete a repo (irreversible). `[--type CHOICE --missing-ok --yes --format CHOICE]`
- `hf repos delete-files REPO_ID PATTERNS` — Delete files from a repo. `[--type CHOICE --revision TEXT --commit-message TEXT --commit-description TEXT --create-pr --format CHOICE]`
- `hf repos duplicate FROM_ID` — Duplicate a repo. `[--type CHOICE --private --public --protected --exist-ok --flavor CHOICE --storage CHOICE --sleep-time INTEGER --secrets TEXT --secrets-file TEXT --env TEXT --env-file TEXT --volume TEXT --format CHOICE]`
- `hf repos move FROM_ID TO_ID` — Move repo between namespaces.
- `hf repos settings REPO_ID` — Update repo settings. `[--gated CHOICE --private --public --protected --type CHOICE --format CHOICE]`
- `hf repos tag create REPO_ID TAG` — Create a tag. `[--message TEXT --revision TEXT --type CHOICE --format CHOICE]`
- `hf repos tag delete REPO_ID TAG` — Delete a tag. `[--yes --type CHOICE --format CHOICE]`
- `hf repos tag list REPO_ID` — List tags.

## `hf skills` — Manage skills for AI assistants

- `hf skills add` — Download and install for an AI assistant. `[--claude --global --dest PATH --force --format CHOICE]`
- `hf skills preview` — Print the generated `hf-cli` SKILL.md to stdout. `[--format CHOICE]`
- `hf skills update` — Update installed Hugging Face marketplace skills. `[--claude --global --dest PATH --format CHOICE]`

## `hf spaces` — Interact with spaces on the Hub

- `hf spaces card SPACE_ID` — Get the Space card. `[--metadata --text --format CHOICE]`
- `hf spaces dev-mode SPACE_ID` — Enable or disable dev mode. `[--stop --format CHOICE]`
- `hf spaces hardware` — List hardware options.
- `hf spaces hot-reload SPACE_ID` — Hot-reload any Python file. `[--local-file PATH --skip-checks --skip-summary --format CHOICE]`
- `hf spaces info SPACE_ID` — Get info. `[--revision TEXT --expand TEXT --format CHOICE]`
- `hf spaces list` — List spaces or files in a space repo. `[--search TEXT --author TEXT --filter TEXT --sort CHOICE --limit INTEGER --expand TEXT --human-readable --tree --recursive --revision TEXT --format CHOICE]`
- `hf spaces logs SPACE_ID` — Fetch run or build logs. `[--build --follow --tail INTEGER --format CHOICE]`
- `hf spaces pause SPACE_ID` — Pause a Space.
- `hf spaces restart SPACE_ID` — Restart a Space. `[--factory-reboot --format CHOICE]`
- `hf spaces search QUERY` — Semantic search spaces. `[--filter TEXT --sdk TEXT --include-non-running --description --limit INTEGER --format CHOICE]`
- `hf spaces secrets add SPACE_ID` — Add or update secrets. `[--secrets TEXT --secrets-file TEXT --format CHOICE]`
- `hf spaces secrets delete SPACE_ID KEY` — Remove a secret. `[--yes --format CHOICE]`
- `hf spaces secrets list SPACE_ID` — List secrets (values not returned).
- `hf spaces settings SPACE_ID` — Update settings. `[--sleep-time INTEGER --hardware CHOICE --format CHOICE]`
- `hf spaces variables add SPACE_ID` — Add or update env vars. `[--env TEXT --env-file TEXT --format CHOICE]`
- `hf spaces variables delete SPACE_ID KEY` — Remove an env var.
- `hf spaces variables list SPACE_ID` — List env vars.
- `hf spaces volumes delete SPACE_ID` — Remove all volumes.
- `hf spaces volumes list SPACE_ID` — List volumes.
- `hf spaces volumes set SPACE_ID` — Set (replace) volumes. `[--volume TEXT --format CHOICE]`

## `hf webhooks` — Manage webhooks on the Hub

- `hf webhooks create --watch TEXT` — Create new webhook. `[--url TEXT --job-id TEXT --domain CHOICE --secret TEXT --format CHOICE]`
- `hf webhooks delete WEBHOOK_ID` — Delete permanently. `[--yes --format CHOICE]`
- `hf webhooks disable WEBHOOK_ID` — Disable.
- `hf webhooks enable WEBHOOK_ID` — Enable.
- `hf webhooks info WEBHOOK_ID` — Show full details.
- `hf webhooks list` — List all webhooks.
- `hf webhooks update WEBHOOK_ID` — Update. `[--url TEXT --watch TEXT --domain CHOICE --secret TEXT --format CHOICE]`

## Common options

- `--format` — Output format: `--format json` (or `--json`) or `--format table` (default).
- `-q / --quiet` — Print only IDs (one per line).
- `--revision` — Git revision id (branch name, tag, or commit hash).
- `--token` — Use a User Access Token. Prefer `HF_TOKEN` env var.
- `--type` — Repository type (model, dataset, or space).

## Mounting repos as local filesystems (`hf-mount`)

To mount Hub repositories or buckets as local filesystems — no download, no copy, no waiting — use `hf-mount`. Files are fetched on demand. GitHub: https://github.com/huggingface/hf-mount

Install with Homebrew: `brew install hf-mount` (works on macOS and Linux). Or download a release from `https://github.com/huggingface/hf-mount/releases`. Or build from source with `cargo build --release --features nfs,fuse` (Rust 1.89+).

Examples:
- `hf-mount start repo openai-community/gpt2 /tmp/gpt2` — mount a repo (read-only)
- `hf-mount start --hf-token $HF_TOKEN bucket myuser/my-bucket /tmp/data` — mount a bucket (read-write)
- `hf-mount status` / `hf-mount stop /tmp/data` — list or unmount

## Tips

- Use `hf <command> --help` for full options, descriptions, usage, and real-world examples.
- Authenticate with `HF_TOKEN` env var (recommended) or `--token`.
- Update CLI with `hf update`.
