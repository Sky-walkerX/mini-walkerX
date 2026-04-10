import { Probot } from "probot";
import { setupScheduler } from "./scheduler.js";
import {
  handleAssign,
  handleUnassign,
  handleExtend,
  resolveDifficultyLabelFromNames,
  parseIssueRefs,
  AppConfig,
} from "./commands.js";
import { prisma } from "./db.js";

export default (app: Probot) => {
  app.log.info("assign-bot is starting...");

  // Setup cron jobs
  setupScheduler(app);

  app.on("issue_comment.created", async (context) => {
    // Only pay attention to non-bot comments
    if (context.isBot) return;

    const comment = context.payload.comment.body.trim();

    if (comment.startsWith("/assign")) {
      app.log.info("Processing /assign command");
      await handleAssign(context);
    } else if (comment.startsWith("/unassign")) {
      app.log.info("Processing /unassign command");
      await handleUnassign(context);
    } else if (comment.startsWith("/extend")) {
      app.log.info("Processing /extend command");
      await handleExtend(context);
    }
  });

  // Track if issue gets closed so we can close the assignment
  app.on("issues.closed", async (context) => {
    const issue = context.payload.issue;
    const repoOwner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;
    const issueNumber = issue.number;

    app.log.info(`Issue #${issueNumber} closed on ${repoOwner}/${repoName}`);

    const result = await prisma.assignment.updateMany({
      where: {
        repoOwner,
        repoName,
        issueNumber,
        status: "ACTIVE",
      },
      data: { status: "CLOSED" },
    });

    app.log.info(`Marked ${result.count} assignment(s) as CLOSED`);
  });

  // Keep difficultyLabel synced when issue labels change after assignment
  app.on(["issues.labeled", "issues.unlabeled"], async (context) => {
    const issue = context.payload.issue;
    if ((issue as any).pull_request) return;

    const repoOwner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;
    const issueNumber = issue.number;

    const labelNames = (issue.labels ?? []).map((l: any) => l.name);
    const difficultyLabel = resolveDifficultyLabelFromNames(labelNames);

    const result = await prisma.assignment.updateMany({
      where: {
        repoOwner,
        repoName,
        issueNumber,
        status: "ACTIVE",
      },
      data: { difficultyLabel },
    });

    app.log.info(
      `Synced difficultyLabel=${difficultyLabel ?? "null"} for ${result.count} ACTIVE assignment(s) on ${repoOwner}/${repoName}#${issueNumber}`
    );
  });

  // ── PR opened: auto-assign or notify ──────────────────────────────────
  app.on("pull_request.opened", async (context) => {
    const pr = context.payload.pull_request;
    const prAuthor = pr.user?.login;
    if (!prAuthor) return;

    const repoOwner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;

    // Skip if multiple_pr mode
    const config = (await context.config("assign-bot.yml")) as AppConfig | null;
    if (config?.multiple_pr) return;

    // Parse issue refs from PR body + title
    const text = `${pr.title ?? ""}\n${pr.body ?? ""}`;
    const issueNumbers = parseIssueRefs(text, repoOwner, repoName);
    if (issueNumbers.length === 0) return;

    for (const issueNumber of issueNumbers) {
      const activeAssignment = await prisma.assignment.findFirst({
        where: { repoOwner, repoName, issueNumber, status: "ACTIVE" },
        include: { user: true },
      });

      if (!activeAssignment) {
        // ── Case A: No assignee → auto-assign the PR author ──
        const user = await prisma.user.upsert({
          where: { username: prAuthor },
          update: {},
          create: { username: prAuthor },
        });

        // Check global 2-issue cap
        const activeCnt = await prisma.assignment.count({
          where: { userId: user.id, status: "ACTIVE" },
        });
        if (activeCnt >= 2) {
          app.log.info(`PR #${pr.number}: ${prAuthor} already at 2-issue cap, skipping auto-assign for #${issueNumber}`);
          continue;
        }

        // Fetch issue labels for difficulty + deadline
        let difficultyLabel: string | null = null;
        let deadline: Date | null = null;
        try {
          const { data: issue } = await context.octokit.rest.issues.get({
            owner: repoOwner,
            repo: repoName,
            issue_number: issueNumber,
          });
          const labelNames = (issue.labels ?? []).map((l: any) =>
            typeof l === "string" ? l : l.name ?? ""
          );
          difficultyLabel = resolveDifficultyLabelFromNames(labelNames);
        } catch { /* issue might not exist */ }

        const hours = difficultyLabel
          ? ({ basic: 1.5, "very easy": 1.5, easy: 1.5, medium: 3, hard: 5, "very hard": 5, "exceptionally hard": 8 }[difficultyLabel] ?? 3)
          : 3;
        deadline = new Date();
        deadline.setHours(deadline.getHours() + hours);

        await context.octokit.rest.issues.addAssignees({
          owner: repoOwner,
          repo: repoName,
          issue_number: issueNumber,
          assignees: [prAuthor],
        });

        await prisma.assignment.create({
          data: {
            userId: user.id,
            repoOwner,
            repoName,
            issueNumber,
            deadline,
            status: "ACTIVE",
            difficultyLabel,
            linkedPrNumber: pr.number,
          },
        });

        await context.octokit.rest.issues.createComment({
          owner: repoOwner,
          repo: repoName,
          issue_number: issueNumber,
          body: `🔗 @${prAuthor} opened PR #${pr.number} for this issue and has been auto-assigned.`,
        });

        app.log.info(`Auto-assigned ${prAuthor} to ${repoOwner}/${repoName}#${issueNumber} via PR #${pr.number}`);

      } else if (activeAssignment.user.username === prAuthor) {
        // ── Assigned user opened PR → link it (protects from timeout) ──
        await prisma.assignment.update({
          where: { id: activeAssignment.id },
          data: { linkedPrNumber: pr.number },
        });

        await context.octokit.rest.issues.createComment({
          owner: repoOwner,
          repo: repoName,
          issue_number: issueNumber,
          body: `🔗 PR #${pr.number} by @${prAuthor} is now linked to this assignment. The deadline timer is paused while the PR is open.`,
        });

        app.log.info(`Linked PR #${pr.number} to assignment ${activeAssignment.id}`);

      } else {
        // ── Someone else opened a PR while another user is assigned ──
        const assignee = activeAssignment.user.username;

        await context.octokit.rest.pulls.createReview({
          owner: repoOwner,
          repo: repoName,
          pull_number: pr.number,
          event: "COMMENT",
          body: `👋 @${prAuthor}, this issue is currently assigned to @${assignee}. If their PR closes without the issue being resolved, you'll get a chance. First come, first served!`,
        });

        app.log.info(`Notified ${prAuthor} on PR #${pr.number} that #${issueNumber} is assigned to ${assignee}`);
      }
    }
  });

  // ── PR closed: clean up linkedPrNumber ─────────────────────────────────
  app.on("pull_request.closed", async (context) => {
    const pr = context.payload.pull_request;
    const repoOwner = context.payload.repository.owner.login;
    const repoName = context.payload.repository.name;

    // Find any ACTIVE assignments linked to this PR
    const linked = await prisma.assignment.findMany({
      where: {
        repoOwner,
        repoName,
        linkedPrNumber: pr.number,
        status: "ACTIVE",
      },
      include: { user: true },
    });

    if (linked.length === 0) return;

    if (pr.merged) {
      // PR was merged — issue close webhook will mark assignment as CLOSED.
      // Just clear the link so there are no dangling references.
      await prisma.assignment.updateMany({
        where: { id: { in: linked.map((a) => a.id) } },
        data: { linkedPrNumber: null },
      });
      app.log.info(`PR #${pr.number} merged, cleared linkedPrNumber on ${linked.length} assignment(s).`);
    } else {
      // PR closed without merge — clear link so deadline resumes.
      // Reset deadline to now + original hours so user gets fresh time.
      for (const assignment of linked) {
        await prisma.assignment.update({
          where: { id: assignment.id },
          data: { linkedPrNumber: null },
        });

        await context.octokit.rest.issues.createComment({
          owner: repoOwner,
          repo: repoName,
          issue_number: assignment.issueNumber,
          body: `⚠️ PR #${pr.number} by @${assignment.user.username} was closed without merging. The deadline timer has resumed.`,
        });
      }

      app.log.info(`PR #${pr.number} closed without merge, cleared linkedPrNumber on ${linked.length} assignment(s).`);
    }
  });
};
