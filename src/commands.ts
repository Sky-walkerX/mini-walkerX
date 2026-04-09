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

interface AppConfig {
  multiple_pr?: boolean;
}

export async function handleAssign(context: Context<"issue_comment.created">) {
  const issue = context.payload.issue;
  if (!context.payload.comment.user) return;
  const username = context.payload.comment.user.login;
  const repoOwner = context.payload.repository.owner.login;
  const repoName = context.payload.repository.name;
  const issueNumber = issue.number;

  // 1. Fetch config to check if multi_pr is enabled
  const config = (await context.config("assign-bot.yml")) as AppConfig | null;
  const multiplePrAllowed = config?.multiple_pr ?? false;

  // 2. Ensure user exists
  const user = await prisma.user.upsert({
    where: { username },
    update: {},
    create: { username },
  });

  // 3. Check global 2-issue limit
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

  // 4. Check if issue is already assigned
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
          // Waitlist logic to be added
    }
    return;
  }

  // 5. Calculate deadline based on labels (unless multiple PRs allowed)
  let deadline: Date | null = null;
  let deadlineMsg = "No time limit will be enforced.";

  if (!multiplePrAllowed) {
    let hours = DEFAULT_TIME_LIMIT;
    const labels = issue.labels.map((l: any) => l.name.toLowerCase());
    
    for (const label of labels) {
      if (TIME_LIMITS[label]) {
        hours = TIME_LIMITS[label];
        break; // Stop at first matched label
      }
    }

    deadline = new Date();
    deadline.setHours(deadline.getHours() + hours);
    deadlineMsg = `You have ${hours} hours to complete this issue (Deadline: ${deadline.toUTCString()}).`;
  }

  // 6. Apply assignment via GitHub API
  try {
    await context.octokit.rest.issues.addAssignees(
      context.issue({ assignees: [username] })
    );

    // 7. Save to DB
    await prisma.assignment.create({
      data: {
        userId: user.id,
        repoOwner,
        repoName,
        issueNumber,
        deadline,
        status: "ACTIVE",
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
