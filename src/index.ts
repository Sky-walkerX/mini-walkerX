import { Probot } from "probot";
import { setupScheduler } from "./scheduler.js";
import { handleAssign, handleUnassign, handleExtend } from "./commands.js";
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

    await prisma.assignment.updateMany({
      where: {
        repoOwner,
        repoName,
        issueNumber,
        status: "ACTIVE",
      },
      data: { status: "CLOSED" },
    });
  });
};
