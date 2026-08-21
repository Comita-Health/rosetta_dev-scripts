# Comita theme and buttons (all product SPAs)

Every first-party app (Admissions, Accounts, Care, Contracts, **and the
next SPA**) shares one chrome. Do not invent a second palette or a
local `PrimaryButton`.

## Source of truth

1. **Runtime:** `GET /public/branding` (Settings → Branding, per AWS
   account). Same payload for every SPA in that account.
2. **Code fallback:** `@comita/shared` `DEFAULT_APP_PRIMARY_COLOR`
   (`#1a6a7e`) and `DEFAULT_APP_SECONDARY_COLOR` (`#3fa99d`).
3. **Theme factory:** `@comita/shared-ui` `createBrandedTheme`.
4. **Boot wrapper:** `PublicBrandingRoot` (or Admissions’
   `BrandingProvider` + `createBrandedTheme` in `App`).

Contained CTAs use **primary** (dark teal). Header product caps
(ADMISSIONS / MANAGED CARE / …) use **secondary**. Ink / muted /
divider tokens stay in `branding.ts` (`BRAND_INK_COLOR`, …).

## New SPA checklist

- Wrap the tree with `PublicBrandingRoot` and `VITE_API_URL`.
- Import `PrimaryButton` / `SecondaryButton` from `@comita/shared-ui`.
- Header lockup: `HeaderShell` + `ComitaBrandLockup` (do not paste a
  third logo PNG with a white box).
- Do **not** hard-code `#00549C`, `#1976d2`, `#1a6a7e`, or a second
  `createTheme` palette.
- Tailwind (if any) hexes must match `branding.ts`; MUI is canonical.
- Marketing `comita_website` is separate; do not copy its workbook
  blue into product CTAs.

## Do not

- Bake `DEFAULT_APP_*` once at `main.tsx` and skip `/public/branding`.
- Duplicate `packages/app/*/src/components/shared/Button.tsx`.
- Treat empty Settings as “use MUI default blue.”

Details: `comita_admissions/docs/theme-and-buttons.md`,
`packages/app/shared/src/utils/branding.ts`,
`packages/app/shared-ui/src/createBrandedTheme.ts`.
