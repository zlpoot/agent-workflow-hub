# Dashboard Local Fast on Windows

Open Dashboard V2 → **添加项目** → choose **Local Fast** in the existing V1 Enrollment area → browse/select the original Git checkout → **检查 Local Fast 项目** → confirm. Existing binding, Watcher directory and Viewer project scope are associated automatically. **查看 V2 任务** opens the task cards and GitHub/Watcher history. No CP Project, Run or Event is created.

For a new unbound checkout, enter the exact ordered Issues, one bounded focused check per line and `personal-gh` (default) or an already connected `github-app`. Confirm uses the existing `LocalFast.bind`, then reads it back. Conflicting queues are preserved. This does not start development.

**查询 Watcher** displays the saved scope and expiration, lock and queue status. With a matching valid Windows Owner scope, **启动已有 Owner scope** runs the existing Watcher. **停止本 GUI Watcher** and Viewer exit abort only Watchers started by this Viewer; external Watchers and locks remain untouched. Poll with 查询 Watcher; V2 observes local state every 10 seconds and GitHub according to its refresh control. Completed queues cannot be restarted here. Waiting for Review, open the PR from the task detail and copy its ChatGPT Review instruction; GUI does not submit Reviews.

`GUI_OWNER_CONFIRMATION_NOT_INTEGRATED`: the existing Owner authorization requires an interactive Windows terminal. If no valid scope exists, expand **Windows Owner 确认引导** and have the Owner run the installed Client's existing `watch authorize` in that selected checkout. Explicitly confirm repository, finite queue, UTC expiry within 30 days, installed Codex.exe and whether merge is permitted. Return to GUI, query and start. Browser confirmation cannot grant this scope, renew it, retry blocked attempts or remove locks. Full GUI native Owner confirmation is not delivered.

An installation operator enables this optional bridge once in the **external isolated Viewer configuration**:

```json
"local_fast_projects": {
  "project_roots": ["E:\\projects"],
  "state_directory": "C:\\Users\\Owner\\AppData\\Local\\AWH\\viewer-local-state"
}
```

The state directory must already exist outside Git repositories, with OS-user deployment protections. It saves only explicitly confirmed checkout associations in `dashboard-local-fast.json`. Empty `viewer.project_ids` is permitted for this bridge; project scope is restored from those saved associations. No `machine_config_file` or CP Enrollment is needed. The CP database remains an existing, compatible, read-only database (use a fresh isolated empty CP for verification). V1 CP Enrollment/Doctor and V2 App Settings remain available as configured. Existing explicit observation deployments remain compatible.

This Issue's acceptance reads the completed Sandbox only. New business queue execution still requires that repository's separate Owner authorization. Simulated queue tests do not establish a new business real E2E. Deployment/cutover, all-asset release construction and independent Review remain outside this task.
