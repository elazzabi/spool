# Example repository pool

MDSpool never clones repositories. Before using the example configuration, create one or more clean local clones yourself and point `repositories[].clones` at them.

```sh
git clone https://github.com/example/widget.git ~/src/widget-review-1
git clone https://github.com/example/widget.git ~/src/widget-review-2
```

Both paths may map to the same GitHub repository. MDSpool leases separate clean clones so two reviews can run in parallel. A third job remains queued until a clone is released.

A clone is skipped without modification when it is dirty, already leased, in the middle of a Git operation, missing its matching GitHub `origin`, or carrying an invalid MDSpool sentinel. MDSpool does not stash, reset, clean, checkout, pull, or otherwise repair a clone. Inspect a quarantined clone yourself and restore it to the intended state, then either check off the generated Markdown action or acknowledge the clone by path:

```sh
spool workspace acknowledge ~/src/widget-review-1
```

The command does not require knowing which note started the job. A running daemon consumes the durable request on its next pass and re-inspects the clone before releasing it. `spool workspace list` and `spool status` show pending and refused requests, including refusal reasons. If no daemon is running and a short-lived MDSpool command happened to hold the state lock, rerun the command to inspect and release the clone directly.
