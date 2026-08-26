# TaskFlow Test Templates — the HELD-OUT benchmark

Twenty natural-language prompts for **`apps/taskflow-web`**, AgenticQA's held-out target app.

## What this file is for

`TEST_TEMPLATES.md` (demo-web) is not an honest measure of generalization: its prompts, demo-web's
hand-curated knowledge pack, and the planner's scenario matcher were all authored together, so a high
score there is close to guaranteed. This file exists to answer the question that one cannot:
**does AgenticQA work on an application it was not built around?**

Rules that keep it honest — please preserve them:

1. **Written from TaskFlow's UX, not from AgenticQA's capabilities.** Each prompt describes what a QA
   engineer would actually want verified. None was reworded to suit what the pipeline currently handles.
2. **No knowledge pack.** `apps/taskflow-web` deliberately ships without `.agenticqa/knowledge.json` —
   it has to be earned (by G1.4's generator), not hand-written.
3. **Vocabulary is disjoint from demo-web** (project / task / assignee / priority / member / workspace —
   never product / cart / checkout / category), and routes differ too (`/login`, not `/auth/login`).
4. **Don't tune the app or these prompts to make the number go up.** If a prompt fails, fix the engine.

Run it with:

```bash
cd packages/orchestrator
node scripts/batchRunTemplates.js --app=apps/taskflow-web \
     --templates=TEST_TEMPLATES_TASKFLOW.md --project=chromium
```

Seeded accounts (real literals in `src/services/seedUsers.ts`):
`ada@taskflow.test` / `Taskflow123!` (Member) · `grace@taskflow.test` / `Admin123!` (Admin)

---

## Dashboard & Navigation

### 1. Dashboard Summary Tiles
```
Open the dashboard and verify the "Your Work" heading is visible along with the summary tiles for Open, In Progress and Done.
```

### 2. Main Navigation
```
From the dashboard, confirm the navigation bar offers Dashboard, Projects, Team and Settings, then click Projects and verify the Projects page opens.
```

---

## Projects

### 3. Projects Table
```
Go to the Projects page and verify the workspace projects table lists Apollo Redesign and Beacon Analytics with their owners and statuses.
```

### 4. Filter Projects by Name
```
On the Projects page, type "Beacon" into the Filter projects box and verify only Beacon Analytics remains in the table.
```

### 5. Filter Projects by Status
```
On the Projects page, set the Status dropdown to Paused and verify Cobalt Migration is listed while Apollo Redesign is not.
```

### 6. Sort Projects by Owner
```
Go to the Projects page, change the Sort by dropdown to Owner, and verify the table reorders so Cobalt Migration is now listed above Beacon Analytics.
```

### 7. Open a Project
```
From the Projects page, click Apollo Redesign and verify the project detail page shows the Apollo Redesign heading and a Tasks table containing "Audit the navigation hierarchy".
```

### 8. Project With No Tasks
```
Open the Delta Onboarding project and verify it shows the empty message "This project has no tasks yet" instead of a task table.
```

---

## Creating Tasks

### 9. Create a Task
```
Go to Create Task, fill in the task title "Review the sprint plan", pick Beacon Analytics as the project, assign it to Grace Hopper, set priority to High, and click Create task. Verify a confirmation message mentioning Beacon Analytics appears.
```

### 10. Task Title Is Required
```
Open the Create Task form, leave the task title empty, click Create task, and verify the validation error "Task title is required" is shown.
```

### 11. Task Labels
```
On the Create Task form, tick the Bug and Documentation label checkboxes and confirm both stay checked.
```

### 12. Task Due Date
```
On the Create Task form, enter a task title and set the Due date field to 2026-09-15, then verify the date is retained in the field.
```

---

## Team

### 13. Team Members
```
Open the Team page and verify the members table lists Ada Lovelace, Grace Hopper and Katherine Johnson together with their roles.
```

### 14. Invite a Member
```
On the Team page, click Invite member, enter newcolleague@taskflow.test as the work email, choose the Viewer role, and send the invite. Verify the confirmation message names that email address.
```

### 15. Invite Validation
```
On the Team page, open the Invite member dialog, type "not-an-email" in the work email field, submit it, and verify the error "Enter a valid email address" appears.
```

---

## Settings

### 16. Save Settings
```
Go to Settings, change the Display name to "Ada L." and the Timezone to Europe/London, click Save changes and verify the "Settings saved" confirmation.
```

### 17. Delete Workspace Confirmation
```
On the Settings page, click Delete workspace and verify a confirmation dialog appears asking whether you are sure, offering both a delete and a keep option.
```

---

## Authentication

### 18. Sign In
```
Go to the sign in page, enter ada@taskflow.test and Taskflow123!, click Sign in, and verify the dashboard loads showing that Ada Lovelace is signed in.
```

### 19. Sign In With Wrong Credentials
```
Attempt to sign in with nobody@taskflow.test and WrongPass1!, then verify the error "Those credentials were not recognised" is displayed and the dashboard does not open.
```

### 20. Sign Out
```
Sign in as grace@taskflow.test with Admin123!, then click Sign out and verify the navigation bar shows the Sign in link again.
```
