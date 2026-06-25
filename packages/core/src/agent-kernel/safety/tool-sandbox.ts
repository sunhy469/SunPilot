/**
 * Tool Sandbox — runtime isolation for tool execution (§5 of architecture next steps).
 *
 * Provides:
 * - Filesystem access restrictions (allowed paths, read-only zones)
 * - Shell command whitelist/blacklist
 * - Network access control (allowed domains/IPs)
 * - Timeout and resource limits
 * - Working directory isolation
 * - Environment variable allowlist
 * - Output size limits
 * - Subprocess cleanup
 */

// ── Sandbox Types ────────────────────────────────────────────────────────

export type SandboxMode = "strict" | "moderate" | "permissive";

export interface FilesystemSandboxConfig {
  /** Allowed read paths. If empty, read is unrestricted. */
  allowedReadPaths: string[];
  /** Allowed write paths. If empty, write is unrestricted. */
  allowedWritePaths: string[];
  /** Blocked paths (takes precedence over allowed). */
  blockedPaths: string[];
  /** Maximum file size for reads (bytes). Default: 10MB. */
  maxReadSize: number;
  /** Maximum file size for writes (bytes). Default: 50MB. */
  maxWriteSize: number;
}

export interface ShellSandboxConfig {
  /** Allowed commands. If empty and mode is strict, no commands allowed. */
  allowedCommands: string[];
  /** Blocked commands (takes precedence over allowed). */
  blockedCommands: string[];
  /** Maximum command execution time (ms). Default: 30s. */
  timeoutMs: number;
  /** Maximum stdout/stderr output size (bytes). Default: 1MB. */
  maxOutputSize: number;
  /** Whether to allow pipes and redirects. */
  allowPipes: boolean;
  /** Whether to allow subshells ($(...) or backticks). */
  allowSubshells: boolean;
}

export interface NetworkSandboxConfig {
  /** Allowed domains (glob patterns). If empty, all domains allowed. */
  allowedDomains: string[];
  /** Blocked domains (takes precedence over allowed). */
  blockedDomains: string[];
  /** Allowed IP ranges (CIDR notation). */
  allowedIpRanges: string[];
  /** Whether to allow localhost connections. */
  allowLocalhost: boolean;
  /** Maximum request time (ms). Default: 30s. */
  timeoutMs: number;
  /** Maximum response size (bytes). Default: 10MB. */
  maxResponseSize: number;
}

export interface SandboxConfig {
  mode: SandboxMode;
  filesystem: FilesystemSandboxConfig;
  shell: ShellSandboxConfig;
  network: NetworkSandboxConfig;
  /** Working directory for tool execution. */
  workingDirectory: string;
  /** Allowed environment variables (by name). */
  allowedEnvVars: string[];
  /** Maximum total memory per tool execution (bytes). */
  maxMemoryBytes: number;
  /** Whether to clean up subprocesses after tool completion. */
  cleanupSubprocesses: boolean;
}

export interface SandboxValidationResult {
  /** Whether the requested operation is allowed. */
  allowed: boolean;
  /** Reason for rejection (if not allowed). */
  reason?: string;
  /** Specific restrictions that apply. */
  restrictions: string[];
  /** Modified arguments (e.g., paths rewritten to sandbox). */
  modifiedArgs?: Record<string, unknown>;
}

// ── Default Configs per Mode ─────────────────────────────────────────────

const DEFAULT_STRICT: SandboxConfig = {
  mode: "strict",
  filesystem: {
    allowedReadPaths: ["/tmp/sunpilot/", "./workspace/"],
    allowedWritePaths: ["/tmp/sunpilot/", "./workspace/"],
    blockedPaths: [
      "/etc/",
      "/root/",
      "~/.ssh/",
      "~/.aws/",
      "~/.config/",
      "/proc/",
      "/sys/",
      ".env",
      "*.pem",
      "*.key",
      "id_rsa*",
    ],
    maxReadSize: 10 * 1024 * 1024, // 10MB
    maxWriteSize: 50 * 1024 * 1024, // 50MB
  },
  shell: {
    allowedCommands: [
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "grep",
      "find",
      "echo",
      "pwd",
      "which",
      "git",
      "node",
      "npm",
      "pnpm",
      "python3",
      "tsc",
    ],
    blockedCommands: [
      "rm",
      "rmdir",
      "dd",
      "mkfs",
      "mount",
      "umount",
      "chmod",
      "chown",
      "sudo",
      "su",
      "reboot",
      "shutdown",
      "systemctl",
      "kill",
      "pkill",
      "wget",
      "curl",
      "nc",
      "telnet",
      "ssh",
      "scp",
      "rsync",
    ],
    timeoutMs: 30_000, // 30s
    maxOutputSize: 1 * 1024 * 1024, // 1MB
    allowPipes: true,
    allowSubshells: false,
  },
  network: {
    allowedDomains: [],
    blockedDomains: [
      "*localhost*",
      "*127.0.0.1*",
      "*internal*",
      "*.local",
      "metadata.google.internal",
      "169.254.169.254",
    ],
    allowedIpRanges: [],
    allowLocalhost: false,
    timeoutMs: 30_000,
    maxResponseSize: 10 * 1024 * 1024,
  },
  workingDirectory: "/tmp/sunpilot/workspace",
  allowedEnvVars: ["PATH", "HOME", "USER", "LANG", "NODE_ENV"],
  maxMemoryBytes: 512 * 1024 * 1024, // 512MB
  cleanupSubprocesses: true,
};

const DEFAULT_MODERATE: SandboxConfig = {
  ...DEFAULT_STRICT,
  mode: "moderate",
  filesystem: {
    ...DEFAULT_STRICT.filesystem,
    allowedReadPaths: [], // Unrestricted read
    allowedWritePaths: ["./workspace/", "/tmp/sunpilot/"],
    blockedPaths: ["/etc/passwd", "/etc/shadow", "~/.ssh/", "~/.aws/"],
  },
  shell: {
    ...DEFAULT_STRICT.shell,
    blockedCommands: [
      "sudo",
      "su",
      "reboot",
      "shutdown",
      "systemctl",
      "mkfs",
      "dd",
    ],
    allowedCommands: [], // All except blocked
    timeoutMs: 120_000, // 2min
    allowSubshells: true,
  },
  network: {
    ...DEFAULT_STRICT.network,
    blockedDomains: ["metadata.google.internal", "169.254.169.254"],
    allowLocalhost: true,
  },
};

const DEFAULT_PERMISSIVE: SandboxConfig = {
  ...DEFAULT_MODERATE,
  mode: "permissive",
  filesystem: {
    ...DEFAULT_MODERATE.filesystem,
    allowedReadPaths: [],
    allowedWritePaths: [],
    blockedPaths: ["/etc/passwd", "/etc/shadow"],
  },
  shell: {
    ...DEFAULT_MODERATE.shell,
    blockedCommands: ["sudo", "mkfs", "dd if=/dev/"],
    timeoutMs: 300_000, // 5min
    maxOutputSize: 50 * 1024 * 1024, // 50MB
  },
  network: {
    ...DEFAULT_MODERATE.network,
    blockedDomains: [],
    allowLocalhost: true,
    timeoutMs: 120_000,
  },
};

// ── Sandbox ──────────────────────────────────────────────────────────────

/**
 * ToolSandbox — validates tool execution parameters against sandbox rules.
 *
 * Applied before tool execution to prevent:
 * - Unauthorized filesystem access
 * - Dangerous shell commands
 * - Unauthorized network requests
 */
export class ToolSandbox {
  readonly config: SandboxConfig;

  constructor(mode: SandboxMode = "moderate", overrides?: Partial<SandboxConfig>) {
    const base =
      mode === "strict"
        ? DEFAULT_STRICT
        : mode === "moderate"
          ? DEFAULT_MODERATE
          : DEFAULT_PERMISSIVE;
    this.config = { ...base, ...overrides };
  }

  /**
   * Validate a filesystem operation.
   */
  validateFilesystem(params: {
    operation: "read" | "write" | "delete";
    path: string;
    size?: number;
  }): SandboxValidationResult {
    const restrictions: string[] = [];
    const { operation, path, size } = params;

    // Check blocked paths
    for (const blocked of this.config.filesystem.blockedPaths) {
      if (matchPath(path, blocked)) {
        return {
          allowed: false,
          reason: `Path "${path}" matches blocked pattern "${blocked}"`,
          restrictions: [blocked],
        };
      }
    }

    // Check allowed paths
    if (operation === "read" && this.config.filesystem.allowedReadPaths.length > 0) {
      const allowed = this.config.filesystem.allowedReadPaths.some((p) =>
        matchPath(path, p),
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Read path "${path}" is not in allowed read paths`,
          restrictions: this.config.filesystem.allowedReadPaths,
        };
      }
    }

    if ((operation === "write" || operation === "delete") && this.config.filesystem.allowedWritePaths.length > 0) {
      const allowed = this.config.filesystem.allowedWritePaths.some((p) =>
        matchPath(path, p),
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Write path "${path}" is not in allowed write paths`,
          restrictions: this.config.filesystem.allowedWritePaths,
        };
      }
    }

    // Check size limits
    if (size) {
      if (operation === "read" && size > this.config.filesystem.maxReadSize) {
        return {
          allowed: false,
          reason: `File size ${size} exceeds max read size ${this.config.filesystem.maxReadSize}`,
          restrictions: [`maxReadSize: ${this.config.filesystem.maxReadSize}`],
        };
      }
      if (operation === "write" && size > this.config.filesystem.maxWriteSize) {
        return {
          allowed: false,
          reason: `File size ${size} exceeds max write size ${this.config.filesystem.maxWriteSize}`,
          restrictions: [`maxWriteSize: ${this.config.filesystem.maxWriteSize}`],
        };
      }
    }

    return { allowed: true, restrictions };
  }

  /**
   * Validate a shell command.
   */
  validateShell(params: {
    command: string;
    arguments?: string[];
  }): SandboxValidationResult {
    const restrictions: string[] = [];

    const fullCommand = params.arguments
      ? `${params.command} ${params.arguments.join(" ")}`
      : params.command;

    // Extract the base command (first word before space or pipe)
    const baseCommand = params.command.split(/\s/)[0] ?? params.command;
    const normalizedCmd = baseCommand.toLowerCase().replace(/^.*\//, ""); // strip path

    // Check blocked commands
    for (const blocked of this.config.shell.blockedCommands) {
      if (matchCommand(normalizedCmd, blocked) || matchCommand(fullCommand, blocked)) {
        return {
          allowed: false,
          reason: `Command "${normalizedCmd}" matches blocked pattern "${blocked}"`,
          restrictions: [blocked],
        };
      }
    }

    // Check allowed commands (if list is populated)
    if (this.config.shell.allowedCommands.length > 0) {
      const allowed = this.config.shell.allowedCommands.some((c) =>
        matchCommand(normalizedCmd, c),
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Command "${normalizedCmd}" is not in the allowed command list`,
          restrictions: this.config.shell.allowedCommands,
        };
      }
    }

    // Check pipes
    if (!this.config.shell.allowPipes && fullCommand.includes("|")) {
      return {
        allowed: false,
        reason: "Pipes are not allowed in shell commands",
        restrictions: ["no_pipes"],
      };
    }

    // Check subshells
    if (!this.config.shell.allowSubshells) {
      if (/\$\(/.test(fullCommand) || /`/.test(fullCommand)) {
        return {
          allowed: false,
          reason: "Subshells are not allowed",
          restrictions: ["no_subshells"],
        };
      }
    }

    return { allowed: true, restrictions };
  }

  /**
   * Validate a network request.
   */
  validateNetwork(params: {
    url: string;
    method?: string;
  }): SandboxValidationResult {
    const restrictions: string[] = [];
    let hostname: string;

    try {
      const url = new URL(params.url);
      hostname = url.hostname;
    } catch {
      return {
        allowed: false,
        reason: `Invalid URL: "${params.url}"`,
        restrictions: [],
      };
    }

    // Check blocked domains
    for (const blocked of this.config.network.blockedDomains) {
      if (matchDomain(hostname, blocked)) {
        return {
          allowed: false,
          reason: `Domain "${hostname}" matches blocked pattern "${blocked}"`,
          restrictions: [blocked],
        };
      }
    }

    // Check allowed domains
    if (this.config.network.allowedDomains.length > 0) {
      const allowed = this.config.network.allowedDomains.some((d) =>
        matchDomain(hostname, d),
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `Domain "${hostname}" is not in allowed domains`,
          restrictions: this.config.network.allowedDomains,
        };
      }
    }

    // Check localhost
    if (!this.config.network.allowLocalhost) {
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "[::1]"
      ) {
        return {
          allowed: false,
          reason: "Localhost connections are not allowed",
          restrictions: ["no_localhost"],
        };
      }
    }

    return { allowed: true, restrictions };
  }

  /**
   * Get a human-readable summary of sandbox restrictions.
   */
  describe(): string {
    const lines = [
      `Sandbox mode: ${this.config.mode}`,
      `Working directory: ${this.config.workingDirectory}`,
      "",
      "Filesystem:",
      `  Max read: ${formatBytes(this.config.filesystem.maxReadSize)}`,
      `  Max write: ${formatBytes(this.config.filesystem.maxWriteSize)}`,
      `  Blocked paths: ${this.config.filesystem.blockedPaths.length}`,
      "",
      "Shell:",
      `  Timeout: ${this.config.shell.timeoutMs}ms`,
      `  Max output: ${formatBytes(this.config.shell.maxOutputSize)}`,
      `  Pipes: ${this.config.shell.allowPipes}`,
      `  Subshells: ${this.config.shell.allowSubshells}`,
      "",
      "Network:",
      `  Timeout: ${this.config.network.timeoutMs}ms`,
      `  Max response: ${formatBytes(this.config.network.maxResponseSize)}`,
      `  Localhost: ${this.config.network.allowLocalhost}`,
    ];
    return lines.join("\n");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function matchPath(path: string, pattern: string): boolean {
  if (pattern === path) return true;
  if (pattern.endsWith("/") && path.startsWith(pattern)) return true;
  // Simple glob: * matches any sequence except /
  if (pattern.includes("*")) {
    // §B32: escape regex metacharacters in user-supplied patterns before
    // interpolation into new RegExp. This prevents ReDoS via patterns like
    // (a+)+b and also prevents unintended regex semantics from ., +, ?, etc.
    const escaped = escapeRegex(pattern);
    const regex = new RegExp(
      "^" + escaped.replace(/\*/g, "[^/]*") + "$",
    );
    return regex.test(path);
  }
  return path.includes(pattern);
}

function matchCommand(command: string, pattern: string): boolean {
  const cmd = command.toLowerCase().trim();
  const pat = pattern.toLowerCase().trim();

  if (cmd === pat) return true;
  // Pattern like "rm" should match "rm -rf" but not "mrm"
  if (cmd.startsWith(pat + " ")) return true;
  if (cmd === pat.split(" ")[0]) return true;

  // Pattern with args like "dd if=/dev/" should match
  if (pat.includes(" ") && cmd.includes(pat)) return true;

  return false;
}

function matchDomain(hostname: string, pattern: string): boolean {
  // Wildcard: *.example.com
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return hostname.endsWith(suffix) || hostname === suffix;
  }
  // Contains wildcard
  if (pattern.includes("*")) {
    // §B32: escape regex metacharacters before building the regex to prevent
    // ReDoS from user-supplied domain patterns.
    const escaped = escapeRegex(pattern);
    const regex = new RegExp(
      "^" + escaped.replace(/\*/g, ".*") + "$",
      "i",
    );
    return regex.test(hostname);
  }
  return hostname === pattern || hostname.endsWith("." + pattern);
}

/**
 * Escape regex-special characters in a user-supplied string so it can be
 * safely interpolated into a `new RegExp(...)` constructor. §B32
 */
function escapeRegex(s: string): string {
  // Escapes: . + ? ^ $ { } [ ] ( ) | \ /
  return s.replace(/[.+?^${}()|[\]\\\/]/g, "\\$&");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}
