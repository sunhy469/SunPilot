import type { RiskLevel } from '../loop-types.js';

export type Permission =
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'shell.execute'
  | 'network.request'
  | 'database.read'
  | 'database.write'
  | 'secret.read'
  | 'artifact.write'
  | 'memory.write'
  | 'external.send';

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  riskLevel: RiskLevel;
  reasons: string[];
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  title: string;
  description: string;
  riskLevel: RiskLevel;
  requestedAction: {
    skillId: string;
    arguments: Record<string, unknown>;
    permissions: Permission[];
  };
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

/**
 * Risk classification matrix per architecture doc §15.5.
 *
 * low:     read workspace files, query metadata, generate artifacts, read-only diagnostics
 * medium:  modify workspace files, non-destructive shell, known hosts, write memory
 * high:    delete files, batch modify, install/deploy/migrate, DB writes, external send
 * critical: read/export secrets, delete outside workspace, rm -rf, upload keys, bypass sandbox
 */

/** Patterns that indicate destructive commands. */
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-rf?\b/i,
  /\brmdir\b/i,
  /\bdel\s+\/f\b/i,
  /\bchmod\s+777\b/i,
  /\bchown\s+-R\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bformat\s+(c:|[a-z]:)/i,
  /\b>\/dev\/sd[a-z]\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\b/i,
];

/** Patterns that indicate secret exposure. */
const SECRET_PATTERNS = [
  /\bAPI[_\s]?KEY\b/i,
  /\bSECRET[_\s]?KEY\b/i,
  /\bPRIVATE[_\s]?KEY\b/i,
  /\bPASSWORD\b/i,
  /\bTOKEN\b/i,
  /\b\.env\b/i,
  /\bCREDENTIALS\b/i,
];

/**
 * Classify risk level based on skill category, arguments, and context.
 * Implements the matrix from architecture doc §15.5.
 */
export function classifyRisk(
  skillCategory: string,
  args: Record<string, unknown>,
): { riskLevel: RiskLevel; reasons: string[] } {
  const reasons: string[] = [];

  // Check arguments for destructive commands
  const argStrings = Object.values(args)
    .filter((v): v is string => typeof v === 'string')
    .join(' ');

  for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
    if (pattern.test(argStrings)) {
      return {
        riskLevel: 'critical',
        reasons: [`Destructive command detected: ${pattern.source}`],
      };
    }
  }

  // Check for secret patterns
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(argStrings)) {
      return {
        riskLevel: 'critical',
        reasons: [`Potential secret access: ${pattern.source}`],
      };
    }
  }

  switch (skillCategory) {
    case 'filesystem': {
      if (args.path && typeof args.path === 'string') {
        if (
          args.path.includes('/etc/') ||
          args.path.includes('/home/') ||
          args.path.startsWith('/')
        ) {
          return {
            riskLevel: 'high',
            reasons: ['Filesystem operation on system path'],
          };
        }
      }
      if (args.operation === 'delete' || args.operation === 'rm') {
        return {
          riskLevel: 'high',
          reasons: ['File deletion operation'],
        };
      }
      return { riskLevel: 'low', reasons: ['Standard filesystem operation'] };
    }

    case 'shell':
      return {
        riskLevel: 'high',
        reasons: ['Shell execution always requires caution'],
      };

    case 'network':
      return {
        riskLevel: 'medium',
        reasons: ['Network operations'],
      };

    case 'database':
      if (
        typeof args.query === 'string' &&
        /\b(DELETE|DROP|TRUNCATE|UPDATE|INSERT)\b/i.test(args.query)
      ) {
        return {
          riskLevel: 'high',
          reasons: ['Database write operation'],
        };
      }
      return { riskLevel: 'medium', reasons: ['Database operation'] };

    case 'memory':
      return { riskLevel: 'low', reasons: ['Memory operation'] };

    case 'artifact':
      return { riskLevel: 'low', reasons: ['Artifact operation'] };

    default:
      return { riskLevel: 'low', reasons: ['Unknown skill category'] };
  }
}

/** Default approval expiry per risk level (in minutes). */
export const APPROVAL_EXPIRY_MINUTES: Record<string, number> = {
  low: 60,
  medium: 30,
  high: 15,
  critical: 0, // Don't auto-create; require explicit admin policy
};
