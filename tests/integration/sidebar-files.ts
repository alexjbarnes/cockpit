import type { Page } from "@playwright/test";

/** Expand the sidebar's Files & changes panel, leaving it on its current view. */
export async function openSidebarPanel(page: Page): Promise<void> {
  const section = page.getByTestId("sidebar-section-files-changes");
  const toggle = section.getByRole("button", { name: /files & changes/i });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/** Expand the panel and switch it to the file tree. */
export async function openSidebarFiles(page: Page): Promise<void> {
  await openSidebarPanel(page);
  await page.getByTestId("sidebar-files-changes-switch").getByRole("button", { name: "Files" }).click();
}
