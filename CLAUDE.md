# Spark — shared team knowledge (use it)

This project is connected to **Spark**, a shared room of solved problems across the team
(the `spark` MCP server). Use it actively, every session:

- **Search before you grind.** On any error, build failure, or tricky setup step, call
  `search_solutions` with the error text / keywords **before** solving it yourself.
- **Confirm what helped.** If a returned card solved your problem, call `confirm_solution(id)`
  (this verifies it and ranks it up for everyone).
- **Record what you solve.** After fixing something non-trivial, call `record_solution` — put
  the **real error text** in `problem` so search finds it later. Only record things that
  actually worked.
- **Stay oriented.** On a fresh or confusing task, call `get_context`; keep `update_context`
  (especially `status`) current so a teammate joining is instantly up to speed.
- Wrong card? `update_solution` to fix it in place; `delete_solution` to remove a dud — don't
  record a near-duplicate.

Your contributions are auto-attributed to your GitHub/git identity.
