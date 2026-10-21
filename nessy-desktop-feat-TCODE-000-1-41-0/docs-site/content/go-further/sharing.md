# Sharing

Share a chat from its menu (**Share**) or from the share button in the chat header. Nessy first shows a confirmation card: what the page will contain, how many secrets were masked and paths shortened, when the link expires (7 days), and a preview of exactly the page that will be sent. Nothing is sent until you approve.

## What is shared

- The chat as it is: your messages and the agent's, tool calls with their input and displayed result, and thinking. Tool blocks and thinking are collapsed.
- Paths inside the project become relative (`src/app.ts`); other absolute paths become `…/name`. Your home folder and account name do not appear.
- Known secret formats (JWT, `ory_…` tokens, `Bearer` headers, card numbers, private keys and the other tool-output secret rules) are replaced by `[REDACTED:<rule>]`. The check does not find encoded or free-form secrets — read the preview before you approve.

## Where it goes

The page is published to t-artifacts with your dp account, so dp must be signed in. Anyone with the link can open it; the link is the only access control. Shared chats appear in **Settings → Workspace → Published pages** with a Chat badge, where you can extend or delete them.

## Update and stop sharing

- **Shared → Update share** sends the chat as it is now to the same link (with the card again). The expiry does not change.
- **Shared → Stop sharing** deletes the page. If it cannot be deleted right now (dp signed out, network), the deletion is kept and retried from Published pages.
- Deleting a shared chat asks whether to stop sharing too. **Delete, keep the link** leaves the page open until it expires.

Deleting a page does not recall copies readers already saved.

## Pages

Open a page and press **Share** to publish a view-only copy to the company's internal artifact service (t-artifacts). Before anything is sent, Nessy shows exactly what will be published: the access line, the expiry, the size, the scan result and a preview with scripts turned off. The page's data stays local unless you switch on **Include current data snapshot**. The copy is open to anyone with the link for 7 days; extend or delete it in **Settings → Workspace → Published pages**. **Publish latest** updates the same link, and **Unpublish** closes it. Deleting a published page takes its copy down first. A page allowed to run a script on your computer cannot be published, and a page with approved actions is published only after you confirm that visitors get a view-only copy. Craft's public share service is not part of Nessy.

See [Publishing Pages](./publishing-pages) for what publishing sends and how links behave.
