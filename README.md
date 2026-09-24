# Mr. Market

A personal stock watchlist that keeps DCF models alive: compare today's share price with your own valuation,
see your forecast before each quarterly report, and track actual results against your assumptions.

## How it is built

- **This repo (public):** the app itself, served by GitHub Pages. Plain HTML/JavaScript, no build step, no secrets.
- **Data repo (private, added later):** watchlist, parsed transfer sheets and model history as JSON,
  read and written through the GitHub Contents API with a fine-grained token limited to that repo.

## Transfer sheet

Each company model includes a standardised transfer sheet (Forecast, Valuation, Actuals quarterly,
Actuals annual). The app reads rows by their labels, not by cell addresses.

## Status

- v0.1: watchlist page with placeholder prices; Hexatronic valuation from transfer sheet v3.
- v0.2: multiple watchlists (create, switch, rename, delete with double confirmation), search-and-add, day change in % or SEK, sortable columns, next report column, blue theme.
- v0.3: removed chart card and report banner; round country flags; Price / Key figures / History tabs like Avanza with averages row.
- v0.4: first column renamed Company; first tab renamed Value vs. price.
- v0.5: Mr. Market top bar; cache-busting version tags on styles.css and app.js.
- v0.6: real end-of-day prices, key figures, history and report dates from Yahoo Finance via a nightly GitHub Actions job in the private data repo; Settings dialog for the GitHub connection.
