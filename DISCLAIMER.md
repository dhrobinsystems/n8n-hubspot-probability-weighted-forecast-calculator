# ⚠️ Disclaimer & Liability Limitation

> **Disclaimer & Liability Limitation:**
> The code, templates, and workflows in this repository are provided "as-is", without warranty of any kind, express or implied. I disclaim all liability for any direct, indirect, incidental, or consequential damages arising from the use of this software, including but not limited to CRM data corruption, API rate limit exhaustion, billing discrepancies, or pipeline miscalculations.
>
> Users and administrators are solely responsible for ensuring full compliance with applicable data privacy and regulatory frameworks (including GDPR, CCPA, and CAN-SPAM), verifying webhook security, and conducting thorough testing in isolated sandbox environments prior to deploying any automated revenue infrastructure to production portals.

**Use at your own risk.** The code, workflows, and scripts in this repository (`n8n-hubspot-probability-weighted-forecast-calculator`) are provided for educational and architectural demonstration purposes. I publish them as a reference implementation, not as a managed product, financial advice, or a professional service.

## 1. No Warranty ("As-Is" Provision)

All software, n8n JSON blueprints (`workflow.json`), and JavaScript modules are provided **"AS IS" and "AS AVAILABLE"**, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, accuracy, and non-infringement. I do not warrant that the code is error-free, that it runs without interruption, or that it is compatible with any particular n8n version, HubSpot portal configuration, or Google Workspace setup. Third-party API shapes, rate limits, and node parameters change over time; verify every node and request against your own environment.

## 2. Forecasts Are Estimates, Not Guarantees

A probability-weighted forecast is a statistical estimate built from historical conversion behaviour. It is **not** a prediction of what any individual deal will do, and it is **not** a revenue commitment. Results depend on data quality (stage hygiene, close dates, amounts, currency settings), the size and recency of the historical cohort, how representative past deals are of current ones, and the parameters chosen (`LOOKBACK_DAYS`, `PRIOR_STRENGTH`, `MIN_SAMPLE_SIZE`, `ENFORCE_MONOTONIC`). Stages flagged low-confidence can swing widely between runs. Do not use these figures as the sole basis for financial reporting, guidance, compensation, hiring, or investment decisions.

## 3. Data Protection & Privacy Compliance

This software reads deal records from HubSpot and writes aggregated metrics to Google Sheets and, optionally, a dashboard endpoint. It does not export individual deal names or contact data, but you remain **solely responsible** for complying with every applicable data protection and regulatory framework, including GDPR / UK GDPR, CCPA/CPRA, CAN-SPAM, and any regional or sector-specific law. That includes controlling who can access the spreadsheet and dashboard, securing any webhook endpoint that receives forecast data, and keeping service account keys and access tokens out of source control.

## 4. API Rate-Limit & Quota Risk

Each run reads up to `MAX_DEAL_PAGES` pages of 50 deals with stage history, plus the pipeline definitions and account details, and makes several Google Sheets API calls. Large portals, short schedule intervals, or concurrent integrations can exhaust HubSpot or Google API rate limits and quotas, producing delayed, partial, or failed runs. Monitor API usage after deployment.

## 5. Assumption of Risk & Limitation of Liability

By using, copying, modifying, or deploying any part of this repository, you assume all risk associated with that use. **In no event shall dhRobin Systems or the author (DH Robin) be liable** for any direct, indirect, incidental, special, exemplary, or consequential damages, including but not limited to CRM data corruption, overwritten spreadsheet data, API rate-limit exhaustion, billing discrepancies, pipeline miscalculations, inaccurate forecasts, missed targets, or downstream commercial and financial decisions, however caused and on any theory of liability, even if advised of the possibility of such damage.

## 6. Production Testing Required

Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every spreadsheet write as something that cannot be undone. Before you set `SANDBOX_MODE=false` and `ALLOW_PRODUCTION_MODE=true`:

1. Run the test suite (`npm test`).
2. Review dry-run output for your own pipelines.
3. Write to a sandbox spreadsheet and reconcile the totals against HubSpot's own weighted amount.
4. Confirm spreadsheet and dashboard access controls with whoever owns them.

## 7. Third-Party Services

HubSpot, n8n, Google Sheets, and any other product named in this repository are trademarks of their respective owners. This project is independent and is not affiliated with, endorsed by, or sponsored by any of them. You are responsible for complying with each service's terms of service, rate limits, and security requirements.

---

The software is licensed under the MIT License. See [LICENSE](LICENSE). MIT © 2026 dhRobin Systems.
