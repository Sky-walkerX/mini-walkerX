import { Probot, Context } from "probot";
import { prisma } from "./db.js";

// Time mappings based on labels (in hours)
const TIME_LIMITS: Record<string, number> = {
  "basic": 1.5,
  "very easy": 1.5,
  "easy": 1.5,
  "medium": 3,
  "hard": 5,
  "very hard": 5,
  "exceptionally hard": 8,
};

const DEFAULT_TIME_LIMIT = 3;

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/-/g, " ").trim();
}

export function resolveDifficultyLabelFromNames(labelNames: string[]): string | null {
  for (const rawLabel of labelNames) {
    const label = normalizeLabel(rawLabel);
    if (TIME_LIMITS[label] !== undefined) {
      return label;
    }
  }
  return null;
}

// Label groups for consolidating similar labels under one limit key
const LABEL_GROUP: Record<string, string> = {
  "basic":    "easy",
  "very easy": "easy",
  "easy":     "easy",
  "medium":   "medium",
  "hard":     "hard",
  "very hard": "hard",
  "exceptionally hard": "hard",
};

interface AppConfig {
  multiple_pr?: boolean;
  label_limits?: Record<string, number>; // e.g. { easy: 1, medium: 1 }
}

function sanitizeLabelLimits(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};

  const allowedLimitKeys = new Set([
    ...Object.keys(TIME_LIMITS),
    ...Object.values(LABEL_GROUP),
  ]);
  const sanitized: Record<string, number> = {};

  for (const [groupRaw, value] of Object.entries(raw as Record<string, unknown>)) {
    const group = normalizeLabel(groupRaw);
    if (!allowedLimitKeys.has(group)) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) {
      sanitized[group] = Math.floor(n);
    }
  }

  return sanitized;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Optional app-level defaults across all repos.
// Example: DEFAULT_LABEL_LIMITS_JSON={"easy":2,"medium":1,"hard":1}
function getDefaultGlobalLabelLimits(): Record<string, number> {
  return sanitizeLabelLimits(parseJsonObject(process.env.DEFAULT_LABEL_LIMITS_JSON));
}

// Optional org-specific limits map.
// Example: ORG_LABEL_LIMITS_JSON={"iiitl":{"easy":2,"medium":1},"Sky-walkerX":{"easy":1}}
function getOrgGlobalLabelLimits(repoOwner: string): Record<string, number> {
  const orgMap = parseJsonObject(process.env.ORG_LABEL_LIMITS_JSON);
  const ownerEntry = orgMap[repoOwner] ?? orgMap[repoOwner.toLowerCase()];
  return sanitizeLabelLimits(ownerEntry);
}

function getEffectiveLabelLimits(config: AppConfig | null, repoOwner: string): Record<string, number> {
  const defaults = getDefaultGlobalLabelLimits();
  const orgLimits = getOrgGlobalLabelLimits(repoOwner);
  const repoLimits = sanitizeLabelLimits(config?.label_limits);
  return { ...defaults, ...orgLimits, ...repoLimits };
}

function getLimitRule(
  matchedLabel: string,
  labelGroup: string,
  labelLimits: Record<string, number>
): { key: string; limit: number; labelsToCount: string[] } | null {
  // Prefer exact label limit if provided (e.g. "very easy": 3)
  const exactLimit = labelLimits[matchedLabel];
  if (exactLimit !== undefined) {
    return { key: matchedLabel, limit: exactLimit, labelsToCount: [matchedLabel] };
  }

  // Fallback to group limit (e.g. "easy": 3)
  const groupLimit = labelLimits[labelGroup];
  if (groupLimit !== undefined) {
    const labelsInGroup = Object.entries(LABEL_GROUP)
      .filter(([, group]) => group === labelGroup)
      .map(([label]) => label);
    return { key: labelGroup, limit: groupLimit, labelsToCount: labelsInGroup };
  }

  return null;
}

export async function handleAssign(context: Context<"issue_comment.created">) {
  const issue = context.payload.issue;
  if (!context.payload.comment.user) return;
  const username = context.payload.comment.user.login;
  const repoOwner = context.payload.repository.owner.login;
  const repoName = context.payload.repository.name;
  const issueNumber = issue.number;

  // 1. Fetch config
  const config = (await context.config("assign-bot.yml")) as AppConfig | null;
  const multiplePrAllowed = config?.multiple_pr ?? false;
  const labelLimits = getEffectiveLabelLimits(config, repoOwner);

  // 2. Resolve difficulty label from issue labels (needed for deadline + per-label limit)
  //    Normalize hyphens → spaces so "very-easy" matches "very easy", etc.
  const issueLabels = issue.labels.map((l: any) => l.name);
  const matchedLabel = resolveDifficultyLabelFromNames(issueLabels);
  // Map to canonical group (e.g. "basic" → "easy") for limit checking
  const labelGroup = matchedLabel ? (LABEL_GROUP[matchedLabel] ?? matchedLabel) : null;

  // 3. Ensure user exists
  const user = await prisma.user.upsert({
    where: { username },
    update: {},
    create: { username },
  });

  // 4. Check global 2-issue limit
  const activeAssignments = await prisma.assignment.count({
    where: { userId: user.id, status: "ACTIVE" },
  });

  if (activeAssignments >= 2) {
    await context.octokit.rest.issues.createComment(
      context.issue({
        body: `@${username} You are already assigned to 2 active issues across repositories. Please finish those before taking on more.`,
      })
    );
    return;
  }

  // 5. Check per-label limit (exact label first, then group fallback)
  if (matchedLabel && labelGroup) {
    const limitRule = getLimitRule(matchedLabel, labelGroup, labelLimits);
    if (limitRule) {
    const labelCount = await prisma.assignment.count({
      where: { userId: user.id, status: "ACTIVE", difficultyLabel: { in: limitRule.labelsToCount } },
    });
      if (labelCount >= limitRule.limit) {
        await context.octokit.rest.issues.createComment(
          context.issue({
            body: `@${username} You have reached the limit of **${limitRule.limit}** active **${limitRule.key}** issue(s). Please complete one before taking another.`,
          })
        );
        return;
      }
    }
  }

  // 6. Check if issue is already assigned
  const existingAssignment = await prisma.assignment.findFirst({
    where: { repoOwner, repoName, issueNumber, status: "ACTIVE" },
  });

  if (existingAssignment) {
    if (existingAssignment.userId === user.id) {
        await context.octokit.rest.issues.createComment(
            context.issue({ body: `@${username} You are already assigned to this issue.` })
          );
    } else {
        await context.octokit.rest.issues.createComment(
            context.issue({ body: `@${username} This issue is already assigned to someone else. Let me add you to the waitlist (Waitlist feature TBD).` })
          );
    }
    return;
  }

  // 7. Calculate deadline based on matched label (unless multiple PRs allowed)
  let deadline: Date | null = null;
  let deadlineMsg = "No time limit will be enforced.";

  if (!multiplePrAllowed) {
    const hours = (matchedLabel ? TIME_LIMITS[matchedLabel] : undefined) ?? DEFAULT_TIME_LIMIT;

    deadline = new Date();
    deadline.setHours(deadline.getHours() + hours);
    deadlineMsg = `You have ${hours} hours to complete this issue (Deadline: ${deadline.toUTCString()}).`;
  }

  // 8. Apply assignment via GitHub API
  try {
    await context.octokit.rest.issues.addAssignees(
      context.issue({ assignees: [username] })
    );

    // 9. Save to DB (store matched label so future limit checks can query by it)
    await prisma.assignment.create({
      data: {
        userId: user.id,
        repoOwner,
        repoName,
        issueNumber,
        deadline,
        status: "ACTIVE",
        difficultyLabel: matchedLabel,
      },
    });

    await context.octokit.rest.issues.createComment(
      context.issue({
        body: `✅ Successfully assigned to @${username}.\n\n${deadlineMsg}`,
      })
    );
  } catch (err) {
    console.error(err);
    await context.octokit.rest.issues.createComment(
      context.issue({ body: `❌ Failed to assign @${username}.` })
    );
  }
}

export async function handleUnassign(context: Context<"issue_comment.created">) {
  if (!context.payload.comment.user) return;
  const username = context.payload.comment.user.login;
  const repoOwner = context.payload.repository.owner.login;
  const repoName = context.payload.repository.name;
  const issueNumber = context.payload.issue.number;

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return;

  const assignment = await prisma.assignment.findFirst({
    where: { userId: user.id, repoOwner, repoName, issueNumber, status: "ACTIVE" },
  });

  if (assignment) {
    try {
      await context.octokit.rest.issues.removeAssignees(
        context.issue({ assignees: [username] })
      );

      await prisma.assignment.update({
        where: { id: assignment.id },
        data: { status: "UNASSIGNED" },
      });

      await context.octokit.rest.issues.createComment(
        context.issue({
          body: `✅ Successfully unassigned @${username}. Waitlist queue triggers to be processed here.`,
        })
      );
    } catch (e) {
        console.error("Error unassigning:", e)
    }
  }
}

export async function handleExtend(context: Context<"issue_comment.created">) {
  // Logic for maintainers to extend deadline
  if (!context.payload.comment.user) return;
  const comment = context.payload.comment.body;
  const repoOwner = context.payload.repository.owner.login;
  const repoName = context.payload.repository.name;
  const issueNumber = context.payload.issue.number;
  
  // Basic auth check: Must have PUSH, MAINTAIN, or ADMIN rights
  const userPerms = await context.octokit.rest.repos.getCollaboratorPermissionLevel({
    owner: repoOwner,
    repo: repoName,
    username: context.payload.comment.user.login
  });

  const validRoles = ["admin", "maintain", "write"];
  if (!validRoles.includes(userPerms.data.permission)) {
    await context.octokit.rest.issues.createComment(
        context.issue({ body: `❌ You do not have permission to extend deadlines.` })
      );
      return;
  }

  const match = comment.match(/\/extend\s+(\d+)\s*h/i);
  if (!match) {
    await context.octokit.rest.issues.createComment(
      context.issue({ body: `Usage: \`/extend X hours\` (e.g. \`/extend 2 h\`)` })
    );
    return;
  }

  const hoursToAdd = parseInt(match[1]!, 10);

  const assignment = await prisma.assignment.findFirst({
    where: { repoOwner, repoName, issueNumber, status: "ACTIVE" },
  });

  if (!assignment || !assignment.deadline) {
    return; // No active assignment with deadline
  }

  const newDeadline = new Date(assignment.deadline);
  newDeadline.setHours(newDeadline.getHours() + hoursToAdd);

  await prisma.assignment.update({
    where: { id: assignment.id },
    data: { deadline: newDeadline },
  });

  await context.octokit.rest.issues.createComment(
    context.issue({
      body: `✅ Deadline extended by ${hoursToAdd} hours! New deadline: ${newDeadline.toUTCString()}`,
    })
  );
}
