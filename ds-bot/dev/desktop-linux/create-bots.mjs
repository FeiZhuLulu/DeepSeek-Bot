// Ask Chief (mock model) to create two Bots, then wait for them to appear in the sidebar.
export default async function (page) {
  const send = async (text) => {
    const box = page.locator('[contenteditable="true"], textarea').last()
    await box.click()
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
  }
  await send('创建一个叫Writer的bot')
  await page.getByText('Writer', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(4000)
  await send('创建一个叫Coder的bot')
  await page.getByText('Coder', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(5000)
}
