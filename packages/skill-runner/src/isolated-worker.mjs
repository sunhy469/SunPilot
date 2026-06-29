import { isBuiltin, registerHooks } from "node:module";

const BLOCKED_BUILTINS = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "tls",
  "vm",
  "wasi",
  "worker_threads",
]);

function builtinName(specifier) {
  return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isBuiltin(specifier) && BLOCKED_BUILTINS.has(builtinName(specifier))) {
      throw new Error(`Permission denied: direct access to '${specifier}' is disabled; use the Skill SDK.`);
    }
    return nextResolve(specifier, context);
  },
});

const denyDirectNetwork = () => {
  throw new Error("Permission denied: direct network access is disabled; use context.http.request().");
};
Object.defineProperty(globalThis, "fetch", { value: denyDirectNetwork, configurable: false, writable: false });
if ("WebSocket" in globalThis) {
  Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: false, writable: false });
}

const originalGetBuiltinModule = process.getBuiltinModule?.bind(process);
if (originalGetBuiltinModule) {
  Object.defineProperty(process, "getBuiltinModule", {
    configurable: false,
    writable: false,
    value(specifier) {
      if (BLOCKED_BUILTINS.has(builtinName(specifier))) {
        throw new Error(`Permission denied: direct access to '${specifier}' is disabled; use the Skill SDK.`);
      }
      return originalGetBuiltinModule(specifier);
    },
  });
}
Object.defineProperty(process, "kill", {
  configurable: false,
  writable: false,
  value() {
    throw new Error("Permission denied: process signaling is disabled in isolated Skills.");
  },
});
const blockedBindings = new Set([
  "cares_wrap",
  "contextify",
  "fs",
  "http_parser",
  "inspector",
  "module_wrap",
  "natives",
  "pipe_wrap",
  "process_wrap",
  "spawn_sync",
  "tcp_wrap",
  "tls_wrap",
  "udp_wrap",
  "worker",
]);
const originalBinding = process.binding.bind(process);
Object.defineProperty(process, "binding", {
  configurable: false,
  writable: false,
  value(name) {
    if (blockedBindings.has(String(name))) {
      throw new Error(`Permission denied: internal binding '${String(name)}' is disabled in isolated Skills.`);
    }
    return originalBinding(name);
  },
});
if (typeof process._linkedBinding === "function") {
  Object.defineProperty(process, "_linkedBinding", {
    configurable: false,
    writable: false,
    value() {
      throw new Error("Permission denied: linked bindings are disabled in isolated Skills.");
    },
  });
}

let nextCallId = 1;
const pendingCalls = new Map();
const controller = new AbortController();

function send(message) {
  if (!process.send) throw new Error("Skill IPC channel is unavailable.");
  process.send(message);
}

function hostCall(method, args) {
  const id = String(nextCallId++);
  return new Promise((resolve, reject) => {
    pendingCalls.set(id, { resolve, reject });
    send({ type: "host_call", id, method, args });
  });
}

function hostNotify(method, args) {
  send({ type: "host_notify", method, args });
}

function deserializeHostError(error) {
  const value = new Error(typeof error?.message === "string" ? error.message : "Skill host call failed.");
  value.name = typeof error?.name === "string" ? error.name : "Error";
  return value;
}

async function execute(message) {
  const loaded = await import(message.entryUrl);
  const definition = loaded.default;
  if (!definition || definition.id !== message.skillId || definition.version !== message.version) {
    throw new Error("Loaded skill definition does not match manifest.");
  }
  const capability = definition.capabilities?.[message.capability];
  if (!capability) {
    throw new Error(`Skill definition does not export capability: ${message.capability}`);
  }

  const input = capability.input.parse(message.input);
  const context = {
    runId: message.runId,
    stepId: message.stepId,
    skillId: message.skillId,
    capability: message.capability,
    signal: controller.signal,
    events: {
      emit(type, payload) {
        hostNotify("events.emit", { type, payload });
      },
    },
    artifacts: {
      write(input) {
        return hostCall("artifacts.write", input);
      },
    },
    files: {
      readText(path) {
        return hostCall("files.readText", { path });
      },
      writeText(path, content) {
        return hostCall("files.writeText", { path, content });
      },
    },
    memory: {
      write(key, value) {
        return hostCall("memory.write", { key, value });
      },
    },
    secrets: {
      get(name) {
        return hostCall("secrets.get", { name });
      },
    },
    http: {
      request(input) {
        return hostCall("http.request", input);
      },
    },
    logger: {
      info(message, payload) { hostNotify("logger.info", { message, payload }); },
      warn(message, payload) { hostNotify("logger.warn", { message, payload }); },
      error(message, payload) { hostNotify("logger.error", { message, payload }); },
    },
  };

  const result = await capability.handler(input, context);
  return capability.output.parse(result);
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "host_result") {
    const pending = pendingCalls.get(message.id);
    if (!pending) return;
    pendingCalls.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else pending.reject(deserializeHostError(message.error));
    return;
  }
  if (message.type === "abort") {
    controller.abort(new Error(typeof message.reason === "string" ? message.reason : "Skill execution aborted."));
    return;
  }
  if (message.type !== "execute") return;

  void execute(message).then(
    (value) => send({ type: "result", value }),
    (error) => send({
      type: "error",
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
});

process.on("disconnect", () => process.exit(0));
