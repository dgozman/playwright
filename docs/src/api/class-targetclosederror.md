# class: TargetClosedError
* since: v1.63
* extends: [Error]

TargetClosedError is thrown whenever an operation cannot be completed because the page, browser context or browser it operates on has been closed, e.g. [`method: Locator.click`] on a page that is already closed.

```js
const playwright = require('playwright');

(async () => {
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.close();
  try {
    await page.locator('text=Foo').click();
  } catch (error) {
    if (error instanceof playwright.errors.TargetClosedError)
      console.log('Target closed!');
  }
  await browser.close();
})();
```

```python async
import asyncio
from playwright.async_api import async_playwright, TargetClosedError, Playwright

async def run(playwright: Playwright):
    browser = await playwright.chromium.launch()
    page = await browser.new_page()
    await page.close()
    try:
      await page.locator("text=Example").click()
    except TargetClosedError:
      print("Target closed!")
    await browser.close()

async def main():
    async with async_playwright() as playwright:
        await run(playwright)

asyncio.run(main())
```

```python sync
from playwright.sync_api import sync_playwright, TargetClosedError

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.close()
    try:
      page.locator("text=Example").click()
    except TargetClosedError:
      print("Target closed!")
    browser.close()
```

```java
package org.example;

import com.microsoft.playwright.*;

public class TargetClosedErrorExample {
  public static void main(String[] args) {
    try (Playwright playwright = Playwright.create()) {
      Browser browser = playwright.firefox().launch();
      BrowserContext context = browser.newContext();
      Page page = context.newPage();
      page.close();
      try {
        page.locator("text=Example").click();
      } catch (TargetClosedError e) {
        System.out.println("Target closed!");
      }
    }
  }
}
```

```csharp
using Microsoft.Playwright;

using var playwright = await Playwright.CreateAsync();
await using var browser = await playwright.Chromium.LaunchAsync();
var page = await browser.NewPageAsync();
await page.CloseAsync();
try
{
    await page.ClickAsync("text=Example");
}
catch (TargetClosedException)
{
    Console.WriteLine("Target closed!");
}
```
