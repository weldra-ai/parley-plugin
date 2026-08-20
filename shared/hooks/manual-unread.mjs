import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PARLEY_BASE_URL = "https://parley.weldra.dev";
const MAX_RESPONSE_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 3_000;

export function isEntrypoint(scriptPath, moduleUrl = import.meta.url) {
  return typeof scriptPath === "string" && resolve(scriptPath) === fileURLToPath(moduleUrl);
}

function selectToken(environment) {
  const direct = environment.PARLEY_TOKEN;
  const claude = environment.CLAUDE_PLUGIN_OPTION_PARLEY_TOKEN;
  if (direct !== undefined && claude !== undefined && direct !== claude) {
    return null;
  }
  const token = direct ?? claude;
  return typeof token === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(token) ? token : null;
}

function unreadUrl(baseUrl, space) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/unread`;
  url.search = "";
  url.searchParams.set("format", "json");
  url.searchParams.set("space", space);
  url.hash = "";
  return url;
}

function isResolvedSpace(space) {
  return (
    typeof space === "string" &&
    space.length > 0 &&
    space === space.trim() &&
    !/[\u0000-\u001F\u007F]/.test(space)
  );
}

function isSupportedClient(client) {
  return client === "claude" || client === "codex" || client === "gemini";
}

async function abortAndCancelResponse(response, controller, reader = null) {
  controller.abort();
  try {
    if (reader) {
      await reader.cancel();
    } else {
      await response.body?.cancel();
    }
  } catch {
    // Aborting a response can race its stream cancellation; either action closes the transport.
  }
}

async function readSmallBody(response, controller) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await abortAndCancelResponse(response, controller);
    return null;
  }
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await abortAndCancelResponse(response, controller, reader);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function runManualUnread({
  environment = process.env,
  baseUrl = PARLEY_BASE_URL,
  space,
  client,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  write = (line) => process.stdout.write(line),
} = {}) {
  try {
    const token = selectToken(environment);
    if (!token || !isResolvedSpace(space) || !isSupportedClient(client) || typeof fetchImpl !== "function") {
      return;
    }
    const url = unreadUrl(baseUrl, space);
    if (!url) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Agent-Client": client,
        },
      });
      if (!response.ok) {
        await abortAndCancelResponse(response, controller);
        return;
      }
      const body = await readSmallBody(response, controller);
      if (body === null) {
        return;
      }
      const payload = JSON.parse(body);
      const unread = payload?.total;
      if (Number.isSafeInteger(unread) && unread > 0) {
        write(`Parley: ${unread} unread message(s).\n`);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Hook failures must not interrupt local work or disclose credentials.
  }
}

if (isEntrypoint(process.argv[1])) {
  await runManualUnread();
}
