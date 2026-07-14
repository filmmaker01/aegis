# Mobile Template

The runnable Expo mobile app is intentionally not part of `master`.

Use the `mobile` branch when a project needs the mobile template:

```bash
git clone --branch mobile --single-branch <repo-url>
```

or, from an existing checkout:

```bash
git fetch origin
git switch mobile
```

The `mobile` branch contains the Expo app, development-build setup, Maestro E2E runner, iOS IAP foundation, Expo Push notifications, and mobile social auth integration.

Keep general web, backend, infrastructure, deployment, and shared contract work on `master`. Keep mobile runtime work and mobile-specific backend/contracts changes on `mobile`, then merge `master` into `mobile` regularly.
