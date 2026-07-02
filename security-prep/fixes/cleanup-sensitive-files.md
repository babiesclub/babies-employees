# DRAFT plan: remove the two plaintext-password files from the repo

**Status:** DRAFT for review. NOTHING here has been run.

## The two files
| File | State today | Risk |
|---|---|---|
| `scripts/welcome-messages.txt` | **git-TRACKED**, pushed to the **PUBLIC** repo | Every welcome message with `🔐 סיסמא: xxxx` is public and in git history |
| `scripts/credentials-current.txt` | **untracked**, local only | Not on GitHub, but a full username→password table sitting in the working tree; must not be committed and should be handled |

Confirmed: `scripts/.gitignore` currently ignores only `node_modules/`, `service-account.json`, `*.log` — so
neither of these files is ignored today.

---

## Step 1 — Stop tracking `welcome-messages.txt` (keep the local file)

From the repo root:

```powershell
git rm --cached scripts/welcome-messages.txt
```

`--cached` removes it from the index (so it stops being tracked/pushed) but **keeps the file on disk** — the
onboarding scripts still append to it locally.

## Step 2 — Ignore both files going forward

Append to **`scripts/.gitignore`**:

```
welcome-messages.txt
credentials-current.txt
```

(`credentials-current.txt` is untracked, so this just guarantees it never gets committed by accident.)

## Step 3 — Commit the removal + ignore

```powershell
git add scripts/.gitignore
git commit -m "security: stop tracking welcome-messages.txt; ignore credential files"
git push
```

After this, the files are gone from the **latest** commit and will never be re-added.

---

## ⚠ CRITICAL WARNING — git HISTORY still leaks the old passwords

Removing the file from the current commit does **NOT** remove it from history. Anyone can run
`git log`/`git show` on the public repo and read every password that was ever committed in
`welcome-messages.txt`. **The passwords are already public and must be treated as compromised.**

### Therefore (non-optional): ROTATE every currently-valid leaked password
Every password that ever appeared in `welcome-messages.txt` (and in `credentials-current.txt`, in case it was
ever committed in the past) must be rotated. Use the `resetinstructorpassword` callable from
`resetinstructorpassword.js` (deliverable #1) — one call per instructor/driver, then resend the new password.
`credentials-current.txt` / `welcome-messages.txt` are a convenient list of exactly which usernames are affected
(the reader saw ~33 instructors listed). **The operator must confirm the exact list of usernames to rotate.**

> Rotation is what actually protects the app. History cleanup (below) only stops *future* readers from scraping
> the OLD passwords — but once a password is public you should assume it is known, so rotate regardless of
> whether you purge history.

### Optionally: purge the leaked file from git history
Two tools can rewrite history to remove `scripts/welcome-messages.txt` from every past commit:

**Option A — `git filter-repo` (recommended by the Git project)**
```powershell
# One-time install (pip): pip install git-filter-repo
git filter-repo --path scripts/welcome-messages.txt --invert-paths
```
- Pros: fast, actively maintained, the officially recommended tool.
- Cons: rewrites ALL commit hashes; requires a force-push; anyone with a clone must re-clone; needs Python/pip.

**Option B — BFG Repo-Cleaner**
```powershell
# Requires Java. Download bfg.jar from https://rtyley.github.io/bfg-repo-cleaner/
java -jar bfg.jar --delete-files welcome-messages.txt
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```
- Pros: simpler CLI for the common "delete this file everywhere" case; fast.
- Cons: also rewrites history / needs force-push / needs Java; slightly less flexible than filter-repo.

**Tradeoffs common to both:**
- Both require `git push --force` to the public remote, which **breaks every existing clone/fork** and rewrites
  history. Coordinate before doing it.
- GitHub may still serve old commits via cached views / forks / the API for a while; **open a GitHub support
  request** to purge cached views if you need the leak fully scrubbed.
- Even after a perfect history purge, assume the passwords were already scraped → **rotation is still mandatory.**
- Recommendation: **rotate first (mandatory), purge history second (nice-to-have).** Do not delay rotation
  waiting on a history rewrite.

## Verify
- `git ls-files scripts/welcome-messages.txt` returns nothing (no longer tracked).
- The local `scripts/welcome-messages.txt` file still exists on disk.
- (If history purged) `git log --all -- scripts/welcome-messages.txt` returns no commits.
- Every rotated user can log in with their new password; old passwords no longer work.
