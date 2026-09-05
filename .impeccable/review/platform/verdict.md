## verdict

1. Editor identity — resolved. ProjectsApp.tsx keys the editor and disables every row edit/copy switch while it is open. The inspected regression test verifies A → Cancel → B and checks that saving sends B's ID and B's values. This is source/test evidence; the supplied captures do not depict an open editor.
2. Visible version selection — resolved. Both updated Tests captures visibly show selected historical version 1, unchecked version 2, explicit historical/version labels, and a run count of 7 matching the seven visible checks. Source retains selected historical versions, permits deselection, and replaces another selected version of the same test. The inspected regression test checks running pinned v1 and deselecting it without silently upgrading.
3. Design persistence — resolved. DESIGN.md now documents scoped project-workspace type sizes, sentence-case actions, underline-selected wrapping tabs, and readable status-color variants. The sidecar carries the corresponding roles; existing local-report guidance remains. These variants match the recaptures.

## remaining

Clear. All seven original capture paths were reopened and remain valid. No material regression from this fix batch was found. The updated overview action visibly says “Choose tests and source” and its source routes to Tests; fixture and financial-evidence labels remain explicit. The parent reports the final pnpm check passed with 41 files and 334 tests; this reviewer did not rerun it or a detector. This ship disposition covers the scored fixes, not the whole surface or live backend acceptance.

disposition: ship
