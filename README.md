# Pipedream → n8n migration report (CLI)

Pipedream Workflows stops running on **March 31, 2027**, and Pipedream deletes all Workflows data, including connected accounts, by **April 30, 2027**. This command-line tool reads your Pipedream workflows and shows what it takes to move them to [n8n](https://n8n.io): what converts automatically, what needs a rewrite or a check, and what needs manual work.

It runs on your machine. The report doesn't upload anything.

## What it does

- **`report`** analyzes a Pipedream project export ZIP, a GitHub Sync repository or workflow JSON files, and writes `REPORT.md`:
  - a rating per workflow: converts automatically, needs a rewrite or check, needs manual work;
  - npm packages in code steps, and whether n8n Cloud can load them;
  - accounts to reconnect, secrets to re-enter and data stores to save;
  - an effort estimate and an n8n Cloud vs self-hosted recommendation.
- **`pull`** downloads workflow definitions through the Pipedream REST API. Use it when Export Workflows isn't available to you: the export is written to the project's File Store, which Pipedream lists as an Advanced-plan feature. Your API key is only sent to `api.pipedream.com`.

## Quick start

You need Node.js 18 or newer.

```bash
git clone https://github.com/masonuhome/pipedream-to-n8n.git
cd pipedream-to-n8n
npm install
npm run build
node dist/cli.js report path/to/project_export-proj_xxx.zip
```

Or download the prebuilt single file, [workflow-exit.mjs](https://workflowexit.com/cli/workflow-exit.mjs) ([SHA-256](https://workflowexit.com/cli/workflow-exit.mjs.sha256)), and run `node workflow-exit.mjs report ...`.

### Pull workflows through the API

```bash
export PIPEDREAM_API_KEY=...                       # Pipedream > Settings > API keys
node dist/cli.js pull --org o_xxx --id p_xxx       # try one workflow first
node dist/cli.js pull --org o_xxx --ids tree.txt   # IDs from Workspace > ⋯ > "Export tree as text"
node dist/cli.js report pipedream-workflows
```

Without `--id` or `--ids`, `pull` asks Pipedream for the workspace's list of workflows. That route isn't documented, and the API hasn't been confirmed on Free and Basic plans, so start with one workflow. Steps inside if/else, switch and other branch blocks are separate pipelines; `pull` downloads them too and saves them with their workflow.

## What no export contains

Secret values (they come out as `<redacted>`), OAuth tokens (only an account ID), environment variable values, data store records, File Store files, event history and the code of private components. Save what you need before April 30, 2027.

## Converting to n8n

This repository contains the free report and the API pull. Conversion into importable n8n workflow JSON, with code steps adapted for n8n Cloud, is a hosted service at [workflowexit.com](https://workflowexit.com), where the first workflow converts free. The `convert` command in this build only points you there.

## Privacy

- `report` reads files on your machine and sends nothing.
- `pull` sends your API key only to `api.pipedream.com`. You can point it elsewhere with `PIPEDREAM_API_URL`.

## License

MIT. Workflow Exit is an independent project. It is not affiliated with, endorsed by, or sponsored by Pipedream, Inc., Workday, Inc. or n8n GmbH. Product names are trademarks of their owners and are used only to describe compatibility.
