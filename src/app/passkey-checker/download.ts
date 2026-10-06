/** Request a download, never claim it reached disk and never clear browser data here. */
export function downloadReport(text: string, filename: string): void {
  let url: string | undefined;
  let link: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    const created = url;
    setTimeout(() => URL.revokeObjectURL(created), 1000);
  } catch {
    if (url) URL.revokeObjectURL(url);
    throw new Error('The report download could not be started. Results have not been cleared.');
  } finally {
    link?.remove();
  }
}
