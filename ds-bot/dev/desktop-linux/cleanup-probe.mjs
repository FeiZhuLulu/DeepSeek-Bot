// Remove the feasibility-probe webviews; destroying a guest releases its lease in the main process.
export default async function (page) {
  const removed = await page.evaluate(() => {
    const views = [...document.querySelectorAll('webview[data-probe]')]
    for (const view of views) view.remove()
    return views.length
  })
  console.log(`removed ${removed} probe webviews`)
}
