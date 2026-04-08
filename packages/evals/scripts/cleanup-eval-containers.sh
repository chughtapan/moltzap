#!/bin/bash
# Kill moltzap eval containers older than MAX_AGE seconds (default: 1 hour).
# Run manually or as a pre-step before evals to clean up leftovers.

MAX_AGE=${1:-3600}
NOW=$(date +%s)
KILLED=0

# Label-based cleanup (containers created with --label moltzap-eval=true)
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | awk '{print $1}')
  started=$(echo "$line" | awk '{print $2}')
  if [ -n "$started" ] && [ "$((NOW - started))" -gt "$MAX_AGE" ]; then
    age=$((NOW - started))
    echo "Killing stale container $id (age: ${age}s)"
    docker rm -f "$id" 2>/dev/null && KILLED=$((KILLED + 1))
  fi
done < <(docker ps --filter "label=moltzap-eval=true" --format '{{.ID}} {{.Label "moltzap-eval-started"}}' 2>/dev/null)

# Name-based fallback for pre-label containers: use creation timestamp
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | awk '{print $1}')
  created=$(echo "$line" | awk '{print $2}')
  [ -z "$created" ] && continue
  created_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${created%%.*}" +%s 2>/dev/null || date -d "${created%%.*}" +%s 2>/dev/null || continue)
  if [ "$((NOW - created_epoch))" -gt "$MAX_AGE" ]; then
    echo "Killing old container $id (matched by name pattern)"
    docker rm -f "$id" 2>/dev/null && KILLED=$((KILLED + 1))
  fi
done < <(docker ps --filter "name=moltzap-e2e-" --format '{{.ID}} {{.CreatedAt}}' 2>/dev/null)

if [ "$KILLED" -gt 0 ]; then
  echo "Cleaned up $KILLED stale eval container(s)"
else
  echo "No stale eval containers found"
fi
