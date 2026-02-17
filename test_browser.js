const puppeteer = require('puppeteer');

(async () => {
    console.log('🚀 Starting browser tests for Map Plotting Tool...\n');
    
    const browser = await puppeteer.launch({
        headless: false, // Set to false to see the browser
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });
    
    // Collect console messages
    const consoleMessages = [];
    const errors = [];
    
    page.on('console', msg => {
        const text = msg.text();
        consoleMessages.push({ type: msg.type(), text });
        console.log(`[${msg.type()}]`, text);
    });
    
    page.on('pageerror', error => {
        errors.push(error.message);
        console.error('❌ Page Error:', error.message);
    });
    
    try {
        // Navigate to the app
        console.log('📍 Navigating to http://localhost:8765/...');
        await page.goto('http://localhost:8765/', { 
            waitUntil: 'networkidle2',
            timeout: 30000 
        });
        
        console.log('✅ Page loaded successfully\n');
        
        // Wait for the map to initialize
        await page.waitForSelector('#map', { timeout: 5000 });
        await page.waitForSelector('#sidebar', { timeout: 5000 });
        
        // Test 1: Check UI Layout
        console.log('=== TEST 1: UI Layout ===');
        
        const sidebarVisible = await page.evaluate(() => {
            const sidebar = document.getElementById('sidebar');
            const map = document.getElementById('map');
            const sidebarStyles = window.getComputedStyle(sidebar);
            const mapStyles = window.getComputedStyle(map);
            
            return {
                sidebar: sidebarStyles.display !== 'none',
                map: mapStyles.display !== 'none',
                sidebarWidth: sidebarStyles.width,
                mapVisible: mapStyles.display
            };
        });
        
        console.log('Sidebar visible:', sidebarVisible.sidebar ? '✅' : '❌');
        console.log('Map visible:', sidebarVisible.map ? '✅' : '❌');
        console.log('Sidebar width:', sidebarVisible.sidebarWidth);
        console.log();
        
        // Test 2: Check for errors in console
        console.log('=== TEST 2: Console Errors ===');
        const consoleErrors = consoleMessages.filter(m => m.type === 'error');
        if (consoleErrors.length === 0) {
            console.log('✅ No console errors detected');
        } else {
            console.log('❌ Console errors found:');
            consoleErrors.forEach(err => console.log('  -', err.text));
        }
        console.log();
        
        // Test 3: Add Westminster point
        console.log('=== TEST 3: Adding Westminster Point ===');
        console.log('Filling location: SW1A 1AA');
        
        await page.type('#pointInput', 'SW1A 1AA');
        await page.waitForTimeout(500);
        
        // Check for format hint
        const formatHint = await page.$eval('#formatHint', el => el.textContent);
        console.log('Format detected:', formatHint);
        
        await page.type('#pointName', 'Westminster');
        await page.select('#pointType', 'general');
        
        console.log('Clicking Add Point button...');
        await page.click('#addPointBtn');
        
        // Wait for the point to be added
        await page.waitForTimeout(3000);
        
        const point1Status = await page.evaluate(() => {
            const pointsList = document.getElementById('pointsList');
            const pointCount = document.getElementById('pointCount');
            return {
                count: pointsList.children.length,
                countText: pointCount.textContent,
                items: Array.from(pointsList.children).map(li => ({
                    name: li.querySelector('.point-item-name')?.textContent,
                    detail: li.querySelector('.point-item-detail')?.textContent
                }))
            };
        });
        
        console.log('Points count:', point1Status.countText);
        console.log('Points in list:', point1Status.count);
        if (point1Status.items.length > 0) {
            console.log('✅ Westminster point added:');
            point1Status.items.forEach(item => {
                console.log('  - Name:', item.name);
                console.log('    Detail:', item.detail);
            });
        } else {
            console.log('❌ Westminster point was not added');
        }
        console.log();
        
        // Test 4: Add OS Grid point with Cell Site
        console.log('=== TEST 4: Adding OS Grid Cell Site ===');
        console.log('Clearing previous input...');
        await page.click('#pointInput', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        
        console.log('Filling location: TQ 30163 80311');
        await page.type('#pointInput', 'TQ 30163 80311');
        await page.waitForTimeout(500);
        
        const formatHint2 = await page.$eval('#formatHint', el => el.textContent);
        console.log('Format detected:', formatHint2);
        
        await page.click('#pointName', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('#pointName', 'OS Grid Test');
        
        console.log('Selecting Cell Site type...');
        await page.select('#pointType', 'cell');
        
        // Wait for cell fields to appear
        await page.waitForTimeout(500);
        
        // Check if cell fields are visible
        const cellFieldsVisible = await page.evaluate(() => {
            const cellFields = document.getElementById('cellFields');
            return !cellFields.classList.contains('hidden');
        });
        
        console.log('Cell fields visible:', cellFieldsVisible ? '✅' : '❌');
        
        if (cellFieldsVisible) {
            console.log('Setting azimuth to 45...');
            await page.type('.sector-azimuth', '45');
        }
        
        console.log('Clicking Add Point button...');
        await page.click('#addPointBtn');
        
        // Wait for the point to be added
        await page.waitForTimeout(3000);
        
        const point2Status = await page.evaluate(() => {
            const pointsList = document.getElementById('pointsList');
            const pointCount = document.getElementById('pointCount');
            return {
                count: pointsList.children.length,
                countText: pointCount.textContent,
                items: Array.from(pointsList.children).map(li => ({
                    name: li.querySelector('.point-item-name')?.textContent,
                    detail: li.querySelector('.point-item-detail')?.textContent,
                    type: li.querySelector('.point-marker-icon')?.classList.contains('cell') ? 'cell' : 'general'
                }))
            };
        });
        
        console.log('Points count:', point2Status.countText);
        console.log('Points in list:', point2Status.count);
        if (point2Status.count >= 2) {
            console.log('✅ OS Grid Test point added:');
            point2Status.items.forEach(item => {
                console.log('  - Name:', item.name);
                console.log('    Detail:', item.detail);
                console.log('    Type:', item.type);
            });
        } else {
            console.log('❌ OS Grid Test point was not added');
        }
        console.log();
        
        // Final Report
        console.log('=== FINAL REPORT ===');
        console.log('Total console errors:', consoleErrors.length);
        console.log('Total page errors:', errors.length);
        console.log('Points successfully added:', point2Status.count);
        
        if (errors.length > 0) {
            console.log('\n❌ Page Errors:');
            errors.forEach(err => console.log('  -', err));
        }
        
        // Take a screenshot
        await page.screenshot({ path: 'test_screenshot.png', fullPage: true });
        console.log('\n📸 Screenshot saved as test_screenshot.png');
        
        // Keep browser open for 10 seconds for visual inspection
        console.log('\nKeeping browser open for 10 seconds for visual inspection...');
        await page.waitForTimeout(10000);
        
    } catch (error) {
        console.error('\n❌ Test failed with error:', error.message);
        console.error(error.stack);
    } finally {
        await browser.close();
        console.log('\n✅ Browser closed. Tests complete.');
    }
})();
