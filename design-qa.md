# NEWS-003 source menu QA — 2026-09-15

Source visual truth: /Users/huangzhipeng/.codex/generated_images/01a0a494-a331-7b23-ab43-0544ae004240/exec-1fd9cd6f-375b-4f35-8d8d-cd6087839d47.png
Implementation: http://127.0.0.1:4178/favorites
Screenshots: /Users/huangzhipeng/.codex/visualizations/2026/09/15/01a0a494-a331-7b23-ab43-0544ae004240/news-source-hover-audit/06-final-desktop.png and /Users/huangzhipeng/.codex/visualizations/2026/09/15/01a0a494-a331-7b23-ab43-0544ae004240/news-source-hover-audit/05-narrow-fixed.png

## Comparison scope and evidence
Selected option 1, with user-requested category submenu added. Source is a 1448x1086 design concept focused on the sidebar; implementation is 1280x720 CSS/PNG at 1x. Narrow viewport is 390x844 at 1x. Concept is not an exact full-page specification: existing app navigation, favicons, fonts and reading pane are retained intentionally. Source and light implementation were opened together in one comparison tool result; the same sidebar/menu region was inspected for density, clipping and icon size. Full-page implementation and narrow screenshots were then inspected again. Focused menu region is fully legible in these captures; no separate image crop required.

## Findings and iteration history
- Initial dark screenshot 02-menu-categories.png: desktop controls readable and name unobstructed. Then captured matching light theme in 03-menu-light.png for comparison.
- Functional P1: missing Content-Type on category and pin PATCH requests caused successful responses without actual changes. Fixed both callers and added a request-boundary regression test. Real page move to 资讯 persisted after reload; restored 文章. Pin persisted after reload; unpinned to restore preview data.
- Responsive P2: 04-menu-narrow.png showed ellipsis squeezing the favicon in the existing compact icon rail. Fixed by hiding the extra button in the rail. Short left swipe opens the menu there, while full-width touch rows retain reveal actions. 05-narrow-fixed.png confirms intact favicon/tap area. Narrow submenu previously measured x51..239 within 390px and switches to a single panel with 返回; desktop submenu remains adjacent.
- Final desktop evidence 06-final-desktop.png: no remaining actionable visual P0/P1/P2 findings in the scoped menu change.

## Fidelity surfaces
- Typography: existing app font retained, menu 13px with 16px Lucide icons; hierarchy and labels legible. Generated-image font/nav substitutions intentionally not copied.
- Layout: stable row content, reserved 28px ellipsis target, 14px glyph; 188px menu and 160px submenu. No name overlay or list movement on hover. Coarse-pointer menu rows use 44px minimum height.
- Colors: existing theme variables retained; light and dark checked. Delete is semantic red; subtle row tint and menu elevation match selected direction.
- Assets: actual existing favicons and Lucide icons retained; no raster interface recreation. New folder-input, check and chevron-right use the existing Lucide generator.
- Copy: 置顶到最爱 / 取消置顶, 移动到分类, 删除订阅; category list 文章、资讯、播客 with current selection checked. Empty-state guidance updated to menu/swipe entry.

## Verification and remaining gaps
107 full-suite tests passed (/tmp/news-menu-final-tests.log). After refining compact swipe threshold to 20px, affected UI tests passed 15/15 (/tmp/news-ui-final.log). Includes numeric swipe snap, vertical scroll passthrough, cancellation, compact rail menu, JSON requests and category persistence across process restart. Browser category/pin/reload verified, Escape returns focus to trigger. Browser error log empty at final inspection. Real iPhone touch and cross-device production acceptance remain pending; width emulation and unit gesture tests do not substitute for physical-device QA. No commit or deployment.

final result: passed

## Subsequent accepted scope — 2026-09-16 commit checkpoint
The user requested and then authorized desktop hover-only space: the ellipsis reserves zero width at rest; hover, keyboard-visible focus and an open menu reveal a 28px button plus 4px margin. Measured count right edge moves from 160.25 to 128.25px. This supersedes the fixed reserved-space description above. Real hover motion remains a manual QA boundary. Pin markers now follow source-name visibility in automatic compact and manually collapsed sidebars, with computed display verified. Full suite rerun: 107/107 passed, syntax and diff checks passed. No production deployment or physical iPhone acceptance is implied by this checkpoint.
