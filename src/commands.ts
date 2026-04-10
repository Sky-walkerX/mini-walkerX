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

function getSanitizedLabelLimits(config: AppConfig | null): Record<string, number> {
  const raw = config?.label_limits;
  if (!raw || typeof raw !== "object") return {};

  const allowedGroups = new Set(["easy", "medium", "hard"]);
  const sanitized: Record<string, number> = {};

  for (const [group, value] of Object.entries(raw)) {
    if (!allowedGroups.has(group)) continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) {
      sanitized[group] = Math.floor(n);
    }
  }

  return sanitized;
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
  const labelLimits = getSanitizedLabelLimits(config);

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

  // 5. Check per-label limit (if configured for this label group)
  if (labelGroup && labelLimits[labelGroup] !== undefined) {
    const limit = labelLimits[labelGroup];
    // Count ACTIVE assignments whose stored label maps to the same group
    const labelsInGroup = Object.entries(LABEL_GROUP)
      .filter(([, group]) => group === labelGroup)
      .map(([label]) => label);
    const labelCount = await prisma.assignment.count({
      where: { userId: user.id, status: "ACTIVE", difficultyLabel: { in: labelsInGroup } },
    });
    if (labelCount >= limit) {
      await context.octokit.rest.issues.createComment(
        context.issue({
          body: `@${username} You have reached the limit of **${limit}** active **${labelGroup}** issue(s). Please complete one before taking another.`,
        })
      );
      return;
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
