import { Probot } from "probot";
import * as cron from "node-cron";
import { prisma } from "./db.js";

export function setupScheduler(app: Probot) {
  // Run every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    app.log.info("Running scheduler to check expired assignments");

    const now = new Date();
    
    // Find all active assignments that have passed their deadline
    // but do NOT have an open PR linked (linkedPrNumber pauses timeout)
    const expiredAssignments = await prisma.assignment.findMany({
      where: {
        status: "ACTIVE",
        linkedPrNumber: null,
        deadline: {
          lt: now,
        },
      },
      include: {
        user: true,
      },
    });

    for (const assignment of expiredAssignments) {
        
      try {
        // Authenticate as the app (JWT) to look up the installation
        const appOctokit = await app.auth();
        // Get installation ID for the repository
        const installation = await appOctokit.rest.apps.getRepoInstallation({
          owner: assignment.repoOwner,
          repo: assignment.repoName,
        });
        
        const octokit = await app.auth(installation.data.id);

        app.log.info(`Expiring assignment ${assignment.id} for user ${assignment.user.username}`);

        // Update database status
        await prisma.assignment.update({
          where: { id: assignment.id },
          data: { status: "TIMED_OUT" },
        });

        // Unassign from GitHub
        await octokit.rest.issues.removeAssignees({
          owner: assignment.repoOwner,
          repo: assignment.repoName,
          issue_number: assignment.issueNumber,
          assignees: [assignment.user.username],
        });

        // Announce timeout
        await octokit.rest.issues.createComment({
          owner: assignment.repoOwner,
          repo: assignment.repoName,
          issue_number: assignment.issueNumber,
          body: `⏰ @${assignment.user.username}'s time to complete this issue has expired. They have been unassigned. Waitlist logic will pick up the next user...`,
        });
      } catch (err) {
        app.log.error(err, `Failed to process expired assignment ${assignment.id}`);
      }
    }
  });
}
