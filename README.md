# Pathwise on Vercel

This repo adapts the supplied Pathwise HTML and Genesis connector for Vercel serverless functions.

## What's different from the local server

- `public/index.html` is the Pathwise frontend.
- `public/connector.js` intercepts Genesis sign-in and adds a **Sync now** button.
- `api/login.js` signs in and fetches the first grade/schedule snapshot.
- `api/sync.js` signs in again and fetches a fresh snapshot each time you manually sync.
- `lib/genesis.js` contains the Genesis client and HTML parsers reused from the supplied server.

Vercel functions are not persistent servers, so this version does **not** run a background poller or Server-Sent Events. The username/password are held in browser memory after login and sent to the API over HTTPS for each manual sync; they are not saved in localStorage or a database by this connector. Refreshing the page clears that in-memory credential pair, so sign in again to sync. The frontend's own Pathwise saved state may persist separately.

The original Genesis parser was marked untested against the live district site. Deployment success does not guarantee the district's login flow or HTML selectors will work; verify with your account and stop if Genesis indicates SSO/MFA or an authentication failure.

## Deploy

1. Create a GitHub repository and upload the contents of this folder (the files inside `pathwise-vercel`, not the outer folder).
2. In Vercel, choose **Add New → Project**, import that GitHub repository, and deploy with the default settings.
3. In **Project → Settings → Functions**, confirm Node.js runtime settings are compatible with Node 20+.
4. Open the deployed URL, sign in with Genesis, and test **Sync now**.

`GENESIS_BASE` can be set in Vercel Project Settings → Environment Variables if the district endpoint changes. Redeploy after changing environment variables.

## Important limitations

- The function duration is set to 60 seconds in `vercel.json`; the maximum permitted duration depends on your Vercel plan.
- Every sync re-authenticates to Genesis and fetches courses again, so sync can be slower than a persistent session and may hit function time limits for accounts with many classes.
- This connector sends credentials only to your own deployed API over HTTPS. Do not publish your Genesis password in source code or Vercel environment variables. If you do not trust the deployment/account access, do not use it for real credentials.


### Debugging “found no classes” on Vercel

In Vercel, open **Project → Settings → Environment Variables**, add `DEBUG` with value `1` for the environment you are testing, then redeploy. Try signing in again. The API will return a limited gradebook structure diagnostic (table headers, a few row cell texts and link targets—not the full HTML) and the browser logs it in **Developer Tools → Console** as `Pathwise gradebook parser diagnostics`. Share that diagnostic if the parser still finds no classes. Turn `DEBUG` back off after troubleshooting. Vercel's filesystem is ephemeral, so `./debug/gradebook.html` is not a reliable way to retrieve debug files from a deployed function.
