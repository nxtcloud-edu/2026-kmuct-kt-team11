/**
 * The icon set.
 *
 * Drawn from Iconsax (rounded), **linear** for everything: it is a 1.5px hairline
 * at 24px, which is the same weight as the hairlines in `.agents/visual-language.md`
 * and quiet enough to sit beside 400-weight type without reading as a second
 * emphasis tier. The four tab icons additionally carry the **bold** variant, used
 * only for the selected tab — the tab bar has no accent colour to mark selection
 * with, so the filled silhouette is the whole signal. The five category icons have
 * no selected state and therefore no bold twin; `filled` falls back to linear for
 * them rather than throwing, so a caller that passes it generically is not a bug.
 *
 * The source SVGs hardcode their stroke and fill as the literal colour white —
 * they were exported from a dark-canvas Figma file, and on this app's light
 * surfaces every one of them renders as nothing at all. Every path below is normalised to
 * `currentColor` instead, which is also what makes an icon usable inside a
 * `text-secondary` row: it takes the colour of whatever it sits next to, so an
 * inactive tab and its label dim together in one place.
 *
 * They are inlined as components rather than shipped to `public/icons/` for the
 * same reason — an `<img>` cannot inherit text colour. The Figma `<clipPath>` /
 * `<defs>` wrappers are dropped: their ids are export artifacts and would collide
 * the moment two icons render on the same page.
 *
 * Source: /Users/anubilegdemberel/Documents/anu-designer/public/iconsax_icons/icons/free/rounded/
 */
import type { ReactNode } from "react";

export type IconName =
  | "home"
  | "saved"
  | "groups"
  | "account"
  | "cafe"
  | "restaurant"
  | "exhibition"
  | "shop"
  | "activity";

/* ── Path attributes ──────────────────────────────────────────────────────── */

// Every linear path in the set carries the same three stroke attributes, so they
// live here once rather than being retyped 30 times. `strokeMiterlimit` is the
// single exception — only `exhibition` ships it — and is passed at that call site.
const line = {
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const solid = { fill: "currentColor" } as const;

/* ── Linear ───────────────────────────────────────────────────────────────── */

const LINEAR: Record<IconName, ReactNode> = {
  // essential/linear/home_residential-house-dwelling-comfort-living-space-home
  home: (
    <>
      <path
        d="M9.02 2.84016L3.63 7.04016C2.73 7.74016 2 9.23016 2 10.3602V17.7702C2 20.0902 3.89 21.9902 6.21 21.9902H17.79C20.11 21.9902 22 20.0902 22 17.7802V10.5002C22 9.29016 21.19 7.74016 20.2 7.05016L14.02 2.72016C12.62 1.74016 10.37 1.79016 9.02 2.84016Z"
        {...line}
      />
      <path d="M12 17.9902V14.9902" {...line} />
    </>
  ),

  // school-learning/linear/bookmark_save-favorite-read-later-collection-organizer
  saved: (
    <>
      <path
        d="M14 2C16 2 17 3.01 17 5.03V12.08C17 14.07 15.59 14.84 13.86 13.8L12.54 13C12.24 12.82 11.76 12.82 11.46 13L10.14 13.8C8.41 14.84 7 14.07 7 12.08V5.03C7 3.01 8 2 10 2H14Z"
        {...line}
      />
      <path
        d="M6.82 4.99094C3.41 5.56094 2 7.66094 2 11.9009V14.9309C2 19.9809 4 22.0009 9 22.0009H15C20 22.0009 22 19.9809 22 14.9309V11.9009C22 7.59094 20.54 5.48094 17 4.96094"
        {...line}
      />
    </>
  ),

  // users/linear/profile-2user_user-connection-profile-friends-network-social
  groups: (
    <>
      <path
        d="M9.16006 10.87C9.06006 10.86 8.94006 10.86 8.83006 10.87C6.45006 10.79 4.56006 8.84 4.56006 6.44C4.56006 3.99 6.54006 2 9.00006 2C11.4501 2 13.4401 3.99 13.4401 6.44C13.4301 8.84 11.5401 10.79 9.16006 10.87Z"
        {...line}
      />
      <path
        d="M16.4098 4C18.3498 4 19.9098 5.57 19.9098 7.5C19.9098 9.39 18.4098 10.93 16.5398 11C16.4598 10.99 16.3698 10.99 16.2798 11"
        {...line}
      />
      <path
        d="M4.16021 14.56C1.74021 16.18 1.74021 18.82 4.16021 20.43C6.91021 22.27 11.4202 22.27 14.1702 20.43C16.5902 18.81 16.5902 16.17 14.1702 14.56C11.4302 12.73 6.92021 12.73 4.16021 14.56Z"
        {...line}
      />
      <path
        d="M18.3398 20C19.0598 19.85 19.7398 19.56 20.2998 19.13C21.8598 17.96 21.8598 16.03 20.2998 14.86C19.7498 14.44 19.0798 14.16 18.3698 14"
        {...line}
      />
    </>
  ),

  // users/linear/profile_user-account-person-information-settings-details
  // Deliberately the same drawing as `groups` with one figure removed, so the two
  // tabs read as a pair rather than as two unrelated people icons.
  account: (
    <>
      <path
        d="M12.1601 10.87C12.0601 10.86 11.9401 10.86 11.8301 10.87C9.45006 10.79 7.56006 8.84 7.56006 6.44C7.56006 3.99 9.54006 2 12.0001 2C14.4501 2 16.4401 3.99 16.4401 6.44C16.4301 8.84 14.5401 10.79 12.1601 10.87Z"
        {...line}
      />
      <path
        d="M7.16021 14.56C4.74021 16.18 4.74021 18.82 7.16021 20.43C9.91021 22.27 14.4202 22.27 17.1702 20.43C19.5902 18.81 19.5902 16.17 17.1702 14.56C14.4302 12.73 9.92021 12.73 7.16021 14.56Z"
        {...line}
      />
    </>
  ),

  // essential/linear/coffee_mug-caffeine-beverage-aroma-morning-warmth
  cafe: (
    <>
      <path
        d="M17.79 10.4698V17.7898C17.79 20.1198 15.9 21.9998 13.58 21.9998H6.21C3.89 21.9998 2 20.1098 2 17.7898V10.4698C2 8.13977 3.89 6.25977 6.21 6.25977H13.58C15.9 6.25977 17.79 8.14977 17.79 10.4698Z"
        {...line}
      />
      <path d="M5.5 4V2.25" {...line} />
      <path d="M9.5 4V2.25" {...line} />
      <path d="M13.5 4V2.25" {...line} />
      <path
        d="M22 13.1592C22 15.4792 20.11 17.3692 17.79 17.3692V8.94922C20.11 8.94922 22 10.8292 22 13.1592Z"
        {...line}
      />
      <path d="M2 12H17.51" {...line} />
    </>
  ),

  // essential/linear/reserve_booking-appointment-reservation-hold-confirmation
  // A covered dish on a tray. Iconsax has no cutlery glyph at all, and the cloche
  // is the only shape in the library that reads as "a meal is served here".
  restaurant: (
    <>
      <path
        d="M18.97 22H4.96997C1.96997 22 1.96997 20.65 1.96997 19V18C1.96997 17.45 2.41997 17 2.96997 17H20.97C21.52 17 21.97 17.45 21.97 18V19C21.97 20.65 21.97 22 18.97 22Z"
        {...line}
      />
      <path
        d="M20.72 13V17H3.27002V13C3.27002 9.16 5.98002 5.95 9.59002 5.18C10.13 5.06 10.69 5 11.27 5H12.72C13.3 5 13.87 5.06 14.41 5.18C18.02 5.96 20.72 9.16 20.72 13Z"
        {...line}
      />
      <path
        d="M14.5 4.5C14.5 4.74 14.47 4.96 14.41 5.18C13.87 5.06 13.3 5 12.72 5H11.27C10.69 5 10.13 5.06 9.59 5.18C9.53 4.96 9.5 4.74 9.5 4.5C9.5 3.12 10.62 2 12 2C13.38 2 14.5 3.12 14.5 4.5Z"
        {...line}
      />
      <path d="M15 11H9" {...line} />
    </>
  ),

  // building/linear/bank_currency-finance-savings-account-deposit-security
  // Filed under "bank" upstream, but the drawing is a pedimented colonnade — the
  // universal museum/gallery shape, which is what `exhibition` means here.
  exhibition: (
    <>
      <path
        d="M12.37 2.14984L21.37 5.74982C21.72 5.88982 22 6.30981 22 6.67981V9.99982C22 10.5498 21.55 10.9998 21 10.9998H3C2.45 10.9998 2 10.5498 2 9.99982V6.67981C2 6.30981 2.28 5.88982 2.63 5.74982L11.63 2.14984C11.83 2.06984 12.17 2.06984 12.37 2.14984Z"
        {...line}
        strokeMiterlimit={10}
      />
      <path
        d="M22 22H2V19C2 18.45 2.45 18 3 18H21C21.55 18 22 18.45 22 19V22Z"
        {...line}
        strokeMiterlimit={10}
      />
      <path d="M4 18V11" {...line} strokeMiterlimit={10} />
      <path d="M8 18V11" {...line} strokeMiterlimit={10} />
      <path d="M12 18V11" {...line} strokeMiterlimit={10} />
      <path d="M16 18V11" {...line} strokeMiterlimit={10} />
      <path d="M20 18V11" {...line} strokeMiterlimit={10} />
      <path d="M1 22H23" {...line} strokeMiterlimit={10} />
      <path
        d="M12 8.5C12.8284 8.5 13.5 7.82843 13.5 7C13.5 6.17157 12.8284 5.5 12 5.5C11.1716 5.5 10.5 6.17157 10.5 7C10.5 7.82843 11.1716 8.5 12 8.5Z"
        {...line}
        strokeMiterlimit={10}
      />
    </>
  ),

  // shop/linear/shop_cart-basket-purchase-shopping-bag-products
  // The awninged storefront, not a shopping bag: the category is a place you walk
  // into, and a bag would promise a checkout this app does not have.
  shop: (
    <>
      <path
        d="M3.01001 11.2207V15.7107C3.01001 20.2007 4.81001 22.0007 9.30001 22.0007H14.69C19.18 22.0007 20.98 20.2007 20.98 15.7107V11.2207"
        {...line}
      />
      <path
        d="M12 12C13.83 12 15.18 10.51 15 8.68L14.34 2H9.66999L8.99999 8.68C8.81999 10.51 10.17 12 12 12Z"
        {...line}
      />
      <path
        d="M18.31 12C20.33 12 21.81 10.36 21.61 8.35L21.33 5.6C20.97 3 19.97 2 17.35 2H14.3L15 9.01C15.17 10.66 16.66 12 18.31 12Z"
        {...line}
      />
      <path
        d="M5.64 12C7.29 12 8.78 10.66 8.94 9.01L9.16 6.8L9.64001 2H6.59C3.97001 2 2.97 3 2.61 5.6L2.34 8.35C2.14 10.36 3.62 12 5.64 12Z"
        {...line}
      />
      <path
        d="M12 17C10.33 17 9.5 17.83 9.5 19.5V22H14.5V19.5C14.5 17.83 13.67 17 12 17Z"
        {...line}
      />
    </>
  ),

  // money/linear/ticket-star_event-prize-award-fun-activity-entrance
  // A starred admission ticket. `activity` covers anything you book or turn up
  // for, and the ticket is the one shape that carries that without naming a genre.
  activity: (
    <>
      <path
        d="M16.995 4H6.995C3.165 4 2.095 4.92 2.005 8.5C3.935 8.5 5.495 10.07 5.495 12C5.495 13.93 3.935 15.49 2.005 15.5C2.095 19.08 3.165 20 6.995 20H16.995C20.995 20 21.995 19 21.995 15V9C21.995 5 20.995 4 16.995 4Z"
        {...line}
      />
      <path d="M8.99329 4V7.5" {...line} />
      <path d="M8.99329 16.5V20" {...line} />
      <path
        d="M15.025 9.33016L15.645 10.5802C15.705 10.7002 15.825 10.7902 15.955 10.8102L17.335 11.0102C17.675 11.0602 17.815 11.4802 17.565 11.7202L16.565 12.6902C16.465 12.7802 16.425 12.9202 16.445 13.0602L16.685 14.4302C16.745 14.7702 16.385 15.0302 16.085 14.8702L14.855 14.2202C14.735 14.1602 14.585 14.1602 14.465 14.2202L13.235 14.8702C12.925 15.0302 12.575 14.7702 12.635 14.4302L12.875 13.0602C12.895 12.9202 12.855 12.7902 12.755 12.6902L11.765 11.7202C11.515 11.4802 11.655 11.0602 11.995 11.0102L13.375 10.8102C13.515 10.7902 13.625 10.7102 13.685 10.5802L14.295 9.33016C14.435 9.02016 14.875 9.02016 15.025 9.33016Z"
        {...line}
      />
    </>
  ),
};

/* ── Bold ─────────────────────────────────────────────────────────────────── */

// Tab bar only. Each is the exact bold twin of its linear counterpart above —
// same silhouette, same interior mark — so switching tabs reads as the shape
// filling in, not as the icon being swapped for another one.
const BOLD: Partial<Record<IconName, ReactNode>> = {
  // essential/bold/home_house-residence-dwelling-family-comfort-welcome
  home: (
    <path
      d="M20.04 6.81969L14.28 2.78969C12.71 1.68969 10.3 1.74969 8.78999 2.91969L3.77999 6.82969C2.77999 7.60969 1.98999 9.20969 1.98999 10.4697V17.3697C1.98999 19.9197 4.05999 21.9997 6.60999 21.9997H17.39C19.94 21.9997 22.01 19.9297 22.01 17.3797V10.5997C22.01 9.24969 21.14 7.58969 20.04 6.81969ZM12.75 17.9997C12.75 18.4097 12.41 18.7497 12 18.7497C11.59 18.7497 11.25 18.4097 11.25 17.9997V14.9997C11.25 14.5897 11.59 14.2497 12 14.2497C12.41 14.2497 12.75 14.5897 12.75 14.9997V17.9997Z"
      {...solid}
    />
  ),

  // school-learning/bold/bookmark_save-favorite-link-website-organize-read-later
  saved: (
    <>
      <path
        d="M17 4.96V12.08C17 14.07 15.59 14.84 13.86 13.8L12.54 13C12.24 12.82 11.76 12.82 11.46 13L10.14 13.8C8.41 14.84 7 14.07 7 12.08V4.99C7.01 3 8.01 2 10 2H14C15.98 2 16.98 2.99 17 4.96Z"
        {...solid}
      />
      <path
        d="M22 11.9008V14.9308C22 19.9808 20 22.0008 15 22.0008H9C4 22.0008 2 19.9808 2 14.9308V11.9008C2 9.21083 2.57 7.38083 3.85 6.26083C4.5 5.71083 5.5 6.19083 5.5 7.04083V12.0808C5.5 13.5708 6.11 14.7708 7.17 15.3708C8.24 15.9808 9.6 15.8708 10.92 15.0808L12 14.4308L13.09 15.0808C13.83 15.5308 14.6 15.7608 15.32 15.7608C15.86 15.7608 16.37 15.6308 16.83 15.3708C17.89 14.7708 18.5 13.5708 18.5 12.0808V7.03083C18.5 6.18083 19.51 5.70083 20.15 6.26083C21.43 7.38083 22 9.21083 22 11.9008Z"
        {...solid}
      />
    </>
  ),

  // users/bold/profile-2user_user-accounts-social-connections-people-networking
  groups: (
    <>
      <path
        d="M9 2C6.38 2 4.25 4.13 4.25 6.75C4.25 9.32 6.26 11.4 8.88 11.49C8.96 11.48 9.04 11.48 9.1 11.49C9.12 11.49 9.13 11.49 9.15 11.49C9.16 11.49 9.16 11.49 9.17 11.49C11.73 11.4 13.74 9.32 13.75 6.75C13.75 4.13 11.62 2 9 2Z"
        {...solid}
      />
      <path
        d="M14.08 14.1499C11.29 12.2899 6.73996 12.2899 3.92996 14.1499C2.65996 14.9999 1.95996 16.1499 1.95996 17.3799C1.95996 18.6099 2.65996 19.7499 3.91996 20.5899C5.31996 21.5299 7.15996 21.9999 8.99996 21.9999C10.84 21.9999 12.68 21.5299 14.08 20.5899C15.34 19.7399 16.04 18.5999 16.04 17.3599C16.03 16.1299 15.34 14.9899 14.08 14.1499Z"
        {...solid}
      />
      <path
        d="M19.9901 7.3401C20.1501 9.2801 18.7701 10.9801 16.8601 11.2101C16.8501 11.2101 16.8501 11.2101 16.8401 11.2101H16.8101C16.7501 11.2101 16.6901 11.2101 16.6401 11.2301C15.6701 11.2801 14.7801 10.9701 14.1101 10.4001C15.1401 9.4801 15.7301 8.1001 15.6101 6.6001C15.5401 5.7901 15.2601 5.0501 14.8401 4.4201C15.2201 4.2301 15.6601 4.1101 16.1101 4.0701C18.0701 3.9001 19.8201 5.3601 19.9901 7.3401Z"
        {...solid}
      />
      <path
        d="M21.99 16.5904C21.91 17.5604 21.29 18.4004 20.25 18.9704C19.25 19.5204 17.99 19.7804 16.74 19.7504C17.46 19.1004 17.88 18.2904 17.96 17.4304C18.06 16.1904 17.47 15.0004 16.29 14.0504C15.62 13.5204 14.84 13.1004 13.99 12.7904C16.2 12.1504 18.98 12.5804 20.69 13.9604C21.61 14.7004 22.08 15.6304 21.99 16.5904Z"
        {...solid}
      />
    </>
  ),

  // users/bold/profile_user-account-avatar-person-info-identity
  account: (
    <>
      <path
        d="M12 2C9.38 2 7.25 4.13 7.25 6.75C7.25 9.32 9.26 11.4 11.88 11.49C11.96 11.48 12.04 11.48 12.1 11.49C12.12 11.49 12.13 11.49 12.15 11.49C12.16 11.49 12.16 11.49 12.17 11.49C14.73 11.4 16.74 9.32 16.75 6.75C16.75 4.13 14.62 2 12 2Z"
        {...solid}
      />
      <path
        d="M17.08 14.1499C14.29 12.2899 9.73996 12.2899 6.92996 14.1499C5.65996 14.9999 4.95996 16.1499 4.95996 17.3799C4.95996 18.6099 5.65996 19.7499 6.91996 20.5899C8.31996 21.5299 10.16 21.9999 12 21.9999C13.84 21.9999 15.68 21.5299 17.08 20.5899C18.34 19.7399 19.04 18.5999 19.04 17.3599C19.03 16.1299 18.34 14.9899 17.08 14.1499Z"
        {...solid}
      />
    </>
  ),
};

/* ── Icon ─────────────────────────────────────────────────────────────────── */

/**
 * `aria-hidden` is not optional and not exposed as a prop: nothing in this set is
 * the only thing naming its control. Every tab and every category chip carries its
 * own visible text label, so announcing the icon as well would read each item
 * twice.
 */
export function Icon({
  name,
  filled = false,
  size = 24,
  className,
}: {
  name: IconName;
  filled?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {(filled && BOLD[name]) || LINEAR[name]}
    </svg>
  );
}
