// How hard is an npm package to live without on n8n Cloud (only `crypto` and `moment` allowed)?
//   builtin  - n8n already ships an equivalent (this.helpers.httpRequest, Luxon, crypto)
//   sdk      - an API client; the same calls can be made over HTTP with n8n credentials
//   hard     - real library logic (HTML parsing, PDFs, images, browsers); needs self-hosted n8n

export type PackageClass = "allowed" | "builtin" | "sdk" | "hard";

const ALLOWED = new Set(["crypto", "moment"]);

const BUILTIN = new Set([
  "axios",
  "got",
  "node-fetch",
  "request",
  "request-promise",
  "superagent",
  "ky",
  "undici",
  "cross-fetch",
  "isomorphic-fetch",
  "date-fns",
  "date-fns-tz",
  "dayjs",
  "luxon",
  "moment-timezone",
  "lodash",
  "lodash.get",
  "lodash.set",
  "underscore",
  "uuid",
  "nanoid",
  "qs",
  "querystring",
  "crypto-js",
  "md5",
  "sha1",
  "js-sha256",
  "btoa",
  "atob",
  "url",
  "form-data",
  "slugify",
  "validator",
  "ramda",
]);

const SDK_PATTERNS = [
  /^googleapis$/,
  /^@google-cloud\//,
  /^@googleapis\//,
  /^@slack\//,
  /^openai$/,
  /^@anthropic-ai\//,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^stripe$/,
  /^airtable$/,
  /^@notionhq\/client$/,
  /^twilio$/,
  /^@sendgrid\//,
  /^@mailchimp\//,
  /^mailgun/,
  /^@octokit\//,
  /^octokit$/,
  /^@hubspot\//,
  /^shopify-api-node$/,
  /^@shopify\//,
  /^discord\.js$/,
  /^telegraf$/,
  /^node-telegram-bot-api$/,
  /^@supabase\//,
  /^firebase-admin$/,
  /^@aws-sdk\//,
  /^aws-sdk$/,
  /^@microsoft\//,
  /^jsforce$/,
  /^trello/,
  /^asana$/,
  /^@linear\//,
  /^jira-client$/,
  /^jira\.js$/,
  /^resend$/,
  /^postmark$/,
  /^@pinecone-database\//,
  /^replicate$/,
  /^groq-sdk$/,
  /^cohere-ai$/,
  /^@mistralai\//,
  /^@clickup\//,
  /^webflow-api$/,
  /^@typeform\//,
  /^dropbox$/,
  /^zoomus$/,
  /^@zoom\//,
  /^intercom-client$/,
  /^@intercom\//,
  /^mongodb$/,
  /^pg$/,
  /^mysql2?$/,
  /^redis$/,
  /^ioredis$/,
  /^nodemailer$/,
];

export function classifyPackage(name: string): PackageClass {
  if (ALLOWED.has(name)) return "allowed";
  if (BUILTIN.has(name)) return "builtin";
  // Pipedream's per-app packages (@pipedream/slack, @pipedream/google_drive...) wrap REST APIs.
  if (/^@pipedream(hq)?\//.test(name)) return name === "@pipedream/browsers" ? "hard" : "sdk";
  if (SDK_PATTERNS.some((re) => re.test(name))) return "sdk";
  return "hard";
}

/** Python packages: n8n Cloud allows no imports at all; on self-hosted they need the task runner image. */
export function classifyPythonPackage(name: string): PackageClass {
  if (["requests", "httpx", "urllib3", "aiohttp", "dateutil", "pytz", "arrow"].includes(name)) return "builtin";
  if (["openai", "anthropic", "stripe", "slack_sdk", "googleapiclient", "google", "boto3", "notion_client", "twilio", "airtable", "pyairtable", "supabase", "psycopg2", "pymongo", "redis", "sendgrid"].includes(name)) {
    return "sdk";
  }
  return "hard";
}
