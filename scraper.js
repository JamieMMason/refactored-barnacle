const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');

function normalizeSku(sku) {
  return String(sku || '').trim().toUpperCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildElementPath(element) {
  const path = [];
  let el = element;

  while (el && el.type === 'tag') {
    path.unshift(el.name);
    el = el.parent;
  }

  return path.join(' > ');
}

function createSnippet(text, sku) {
  const normalized = normalizeSku(sku);
  const regex = new RegExp(`(.{0,120})(${escapeRegex(normalized)})(.{0,120})`, 'i');
  const match = regex.exec(text);

  if (!match) {
    return text.slice(0, 240).trim();
  }

  return `${match[1]}${match[2]}${match[3]}`.trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    if (char === '\r') {
      continue;
    }

    cell += char;
  }

  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function findSkuColumnIndex(headers) {
  const normalizedHeaders = headers.map((header) => String(header || '').trim().toLowerCase());
  const skuIndex = normalizedHeaders.findIndex((value) => value.includes('sku'));
  return skuIndex >= 0 ? skuIndex : 0;
}

function loadFirstSkusFromCsv(filePath, maxCount = 50) {
  const csvText = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(csvText).filter((row) => row.length > 0);

  if (rows.length < 2) {
    return [];
  }

  const skuIndex = findSkuColumnIndex(rows[0]);
  const skus = rows.slice(1)
    .map((row) => normalizeSku(row[skuIndex] || ''))
    .filter((sku) => sku)
    .slice(0, maxCount);

  return [...new Set(skus)];
}

function buildMilwaukeeSearchUrl(sku) {
  const query = encodeURIComponent(normalizeSku(sku));
  return `https://www.milwaukeetool.com/search?q=${query}&first=0`;
}

function extractPageSummary(html, sku) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  const heading = $('h1').first().text().trim();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  return {
    title,
    heading,
    snippet: createSnippet(bodyText, sku),
    bodyText
  };
}

function writeResultsToCsv(filePath, results) {
  const quote = (value) => `"${String(value || '').replace(/"/g, '""')}"`;
  const headers = ['sku', 'url', 'found', 'title', 'heading', 'snippet', 'error'];
  const lines = [headers.join(',')];

  for (const result of results) {
    const row = headers.map((header) => quote(result[header] ?? '')).join(',');
    lines.push(row);
  }

  fs.writeFileSync(filePath, lines.join('\r\n'), 'utf8');
}

function extractSearchResults(html) {
  console.log(`[DEBUG] extractSearchResults() - Starting to extract search results from HTML (${html.length} bytes)`);
  const $ = cheerio.load(html);
  const products = [];

  console.log(`[DEBUG] Full HTML text:\n${$.text()}`);


  // Look for product items in search results
  const productSelectors = [
    '[data-testid*="product-item"]',
    '.product-card',
    '.product-item',
    '[class*="product-result"]',
    'div[data-testid*="search-result"]'
  ];

  let foundProducts = false;

  for (const selector of productSelectors) {
    console.log(`[DEBUG] extractSearchResults() - Trying selector: ${selector}`);
    $(selector).each((_, element) => {
      const $elem = $(element);
      const link = $elem.find('a[href*="/products/"]').first();
      const href = link.attr('href');
      
      if (!href) return;

      const url = href.startsWith('http') ? href : `https://www.milwaukeetool.com${href}`;
      const title = link.text().trim() || $elem.find('h2, h3, [data-testid*="title"]').first().text().trim();
      const sku = $elem.find('[data-testid*="sku"], .product-sku, .item-number, [class*="sku"]').first().text().trim();
      const price = $elem.find('[data-testid*="price"], .price, [class*="price"]').first().text().trim();
      const image = $elem.find('img').first().attr('src') || $elem.find('img').first().attr('data-src');

      if (title && url) {
        console.log(`[DEBUG] extractSearchResults() - Found product: ${title}`);
        products.push({
          title,
          url,
          sku,
          price,
          image
        });
        foundProducts = true;
      }
    });

    if (foundProducts) {
      console.log(`[DEBUG] extractSearchResults() - Found products with selector: ${selector}`);
      break;
    }
  }

  console.log(`[DEBUG] extractSearchResults() - Extracted ${products.length} products total`);
  return products;
}

function extractProductLink(html, sku) {
  const $ = cheerio.load(html);
  const normalizedSku = normalizeSku(sku);
  const re = new RegExp(escapeRegex(normalizedSku), 'i');

  // Look for product links in search results
  let productLink = null;

  // Try to find a link that contains the SKU
  $('a[href*="/products/"]').each((_, element) => {
    const href = $(element).attr('href');
    const text = $(element).text();
    
    if (href && (re.test(text) || re.test(href))) {
      if (!productLink) {
        productLink = href.startsWith('http') ? href : `https://www.milwaukeetool.com${href}`;
      }
    }
  });

  // Alternative: look in product grid items
  if (!productLink) {
    $('[data-testid*="product"], .product-card, .product-item').each((_, element) => {
      const link = $(element).find('a[href*="/products/"]').first().attr('href');
      const skuText = $(element).find('[data-testid*="sku"], .product-sku, .item-number').text();
      
      if (link && re.test(skuText)) {
        productLink = link.startsWith('http') ? link : `https://www.milwaukeetool.com${link}`;
      }
    });
  }

  return productLink;
}

function extractProductDetails(html) {
  console.log(`[DEBUG] extractProductDetails() - Starting extraction from HTML (${html.length} bytes)`);
  const $ = cheerio.load(html);

  // Extract product image
  let imageUrl = null;
  const imgSelectors = [
    'img[data-testid*="product-image"]',
    'img.product-image',
    'img[alt*="Product"]',
    'img[src*="product"]',
    'picture img'
  ];

  for (const selector of imgSelectors) {
    const img = $(selector).first();
    if (img.length) {
      imageUrl = img.attr('src') || img.attr('data-src');
      if (imageUrl) {
        console.log(`[DEBUG] extractProductDetails() - Found image with selector: ${selector} | URL: ${imageUrl}`);
        break;
      }
    }
  }

  if (!imageUrl) {
    console.log(`[DEBUG] extractProductDetails() - No image URL found`);
  }

  // Extract product description
  let description = null;
  const descSelectors = [
    '[data-testid*="product-description"]',
    '.product-description',
    '.description',
    '[class*="description"]',
    '.product-details p',
    '.product-info p'
  ];

  for (const selector of descSelectors) {
    const elem = $(selector).first();
    if (elem.length) {
      description = elem.text().trim();
      if (description && description.length > 20) {
        console.log(`[DEBUG] extractProductDetails() - Found description with selector: ${selector}`);
        break;
      }
    }
  }

  // Extract product title as fallback
  const title = $('h1, [data-testid*="product-title"], .product-title').first().text().trim();
  console.log(`[DEBUG] extractProductDetails() - Extracted title: ${title || 'N/A'}`);

  return {
    imageUrl,
    description: description || title,
    title
  };
}

function extractSkuMatches(html, skuList) {
  const $ = cheerio.load(html);
  const results = [];

  skuList.forEach((sku) => {
    const normalizedSku = normalizeSku(sku);
    const re = new RegExp(escapeRegex(normalizedSku), 'i');
    const matches = [];

    // Look for SKU in result-sku spans
    $('span.result-sku').each((_, element) => {
      const text = $(element).text().replace(/\s+/g, ' ').trim();

      if (!text || !re.test(text)) {
        return;
      }

      matches.push({
        tag: element.tagName || 'unknown',
        path: buildElementPath(element),
        text: text.slice(0, 400),
        snippet: createSnippet(text, sku)
      });

      if (matches.length >= 5) {
        return false;
      }
    });

    results.push({
      sku,
      found: matches.length > 0,
      matches
    });
  });

  return results;
}

async function fetchPageHtml(url) {
  console.log(`[DEBUG] fetchPageHtml() - Starting fetch from: ${url}`);
  const response = await axios.get(url, {
    headers: {
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0'
    },
    timeout: 20000
  });

  console.log(`[DEBUG] fetchPageHtml() - Successfully fetched from: ${url} (${response.data.length} bytes)`);
  return response.data;
}

async function searchSku(sku) {
  try {
    console.log(`[DEBUG] searchSku() - Searching for SKU: ${sku}`);
    const apiUrl = 'https://www.milwaukeetool.com/api/v1/products/search';
    const searchBody = {
      query: normalizeSku(sku),
      language: 'en',
      facets: [],
      first: 0
    };

    console.log(`[DEBUG] searchSku() - Making POST request to: ${apiUrl}`);
    const response = await axios.post(apiUrl, searchBody, {
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'application/json',
        'sec-ch-ua': '"Chromium";v="148", "Microsoft Edge";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0'
      },
      timeout: 20000
    });

    const data = response.data;
    console.log(`[DEBUG] searchSku() - API returned ${data.results ? data.results.length : 0} results`);

    const products = [];
    
    if (data.results && data.results.length > 0) {
      data.results.forEach((result) => {
        const raw = result.raw || {};
        const productUrl = raw.producturl || '';
        const title = result.title || raw.shortz32xtitle || '';
        const overview = raw.overview || '';
        const primaryImage = raw.primaryimage || '';
        const resultSku = raw.sku || '';

        // Fuzzy match on SKU - check if the search SKU is in the result's SKU
        const searchSkuNormalized = normalizeSku(sku);
        const resultSkuNormalized = normalizeSku(resultSku);
        
        if (searchSkuNormalized === resultSkuNormalized.split('|')[0] || searchSkuNormalized === resultSkuNormalized) {
          const imageUrl = primaryImage ? `https://www.milwaukeetool.com${primaryImage}` : null;

          products.push({
            title,
            url: productUrl ? `https://www.milwaukeetool.com${productUrl}` : '',
            sku: resultSku,
            price: '',
            image: imageUrl,
            description: overview,
            overview
          });

          console.log(`[DEBUG] searchSku() - Matched product: ${title} | SKU: ${resultSku}`);
        }
      });
    }

    console.log(`[DEBUG] searchSku() - Found ${products.length} matching products for SKU: ${sku}`);

    return {
      sku,
      found: products.length > 0,
      products,
      searchUrl: apiUrl,
      error: null
    };
  } catch (error) {
    console.error(`[DEBUG] searchSku() - Error searching for SKU ${sku}:`, error.message);
    return {
      sku,
      found: false,
      products: [],
      searchUrl: 'https://www.milwaukeetool.com/api/v1/products/search',
      error: error.message
    };
  }
}

async function fetchProductDetails(productUrl) {
  try {
    console.log(`[DEBUG] fetchProductDetails() - Fetching product details from: ${productUrl}`);
    const html = await fetchPageHtml(productUrl);
    const { description, imageUrl, title } = extractProductDetails(html);

    console.log(`[DEBUG] fetchProductDetails() - Successfully extracted details for: ${productUrl}`);
    console.log(`  Title: ${title || 'N/A'}`);
    console.log(`  Image URL: ${imageUrl ? 'Found' : 'Not found'}`);
    console.log(`  Description: ${description ? description.substring(0, 80) + '...' : 'N/A'}`);

    return {
      url: productUrl,
      title,
      description,
      imageUrl,
      found: true,
      error: null
    };
  } catch (error) {
    console.error(`[DEBUG] fetchProductDetails() - Error fetching from ${productUrl}:`, error.message);
    return {
      url: productUrl,
      title: null,
      description: null,
      imageUrl: null,
      found: false,
      error: error.message
    };
  }
}

async function scrapeSkuData(url, skuList) {
  console.log(`[DEBUG] scrapeSkuData() - Starting scrape for ${skuList.length} SKUs`);
  const results = [];

  for (let i = 0; i < skuList.length; i++) {
    const sku = skuList[i];
    console.log(`[DEBUG] scrapeSkuData() - Processing SKU ${i + 1}/${skuList.length}: ${sku}`);
    const searchResult = await searchSku(sku);
    results.push(searchResult);
  }

  console.log(`[DEBUG] scrapeSkuData() - Completed scraping. Processed ${results.length} SKUs`);
  return results;
}

async function scrapeFirst50MagentoSkus(csvPath, outputCsvPath = 'milwaukee-scrape-results.csv', skuCount = 50) {
  const skus = loadFirstSkusFromCsv(csvPath, skuCount);
  console.log(`Loaded ${skus.length} SKUs from CSV file: ${csvPath}`);

  if (skus.length === 0) {
    throw new Error('No SKU values found in the provided Magento CSV file.');
  }

  const results = [];

  for (const sku of skus) {
    const url = buildMilwaukeeSearchUrl(sku);
    console.log(`Scraping SKU: ${sku} | URL: ${url}`);

    try {
      const html = await fetchPageHtml(url);
      const { title, heading, snippet, bodyText } = extractPageSummary(html, sku);
      console.log(bodyText);
      const found = new RegExp(escapeRegex(normalizeSku(sku)), 'i').test(bodyText);

      results.push({
        sku,
        url,
        found,
        title,
        heading,
        snippet,
        error: ''
      });
    } catch (error) {
      results.push({
        sku,
        url,
        found: false,
        title: '',
        heading: '',
        snippet: '',
        error: error.message
      });
    }
  }

  writeResultsToCsv(outputCsvPath, results);

  return results;
}

if (require.main === module) {
  const [,, csvPath, outputPath] = process.argv;

  if (!csvPath) {
    console.error('Usage: node scraper.js <magento-csv-path> [output.csv]');
    process.exit(1);
  }

  scrapeFirst50MagentoSkus(csvPath, outputPath)
    .then((results) => {
      console.log(`Scraped ${results.length} SKUs and wrote results to ${outputPath || 'milwaukee-scrape-results.csv'}`);
    })
    .catch((error) => {
      console.error('Scraping failed:', error.message);
      process.exit(1);
    });
}

function convertToMagentoFormat(apiResult) {
  const raw = apiResult.raw || {};
  const sku = raw.sku || raw.z95xname || '';
  let description = raw.overview || '';
  
  // Truncate description after last period
  const lastPeriodIndex = description.lastIndexOf('.');
  if (lastPeriodIndex !== -1) {
    description = description.substring(0, lastPeriodIndex + 1);
  }
  
  const shortDescription = description.substring(0, 255);
  const primaryImage = raw.primaryimage || '';
  const imageUrl = primaryImage ? `https://www.milwaukeetool.com${primaryImage}` : '';

  return {
    sku,
    description: description,
    short_description: shortDescription,
    image: imageUrl,
    small_image: imageUrl,
    thumbnail: imageUrl
  };
}

function magentoResultsToCsv(results) {
  if (!results || results.length === 0) {
    return '';
  }

  // Collect all unique keys from all results to build headers
  const allKeys = new Set();
  results.forEach((result) => {
    Object.keys(result).forEach((key) => {
      allKeys.add(key);
    });
  });

  const headers = Array.from(allKeys);
  const quote = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.map(quote).join(',')];

  for (const result of results) {
    const row = headers.map((header) => quote(result[header] ?? '')).join(',');
    lines.push(row);
  }

  return lines.join('\r\n');
}

async function generateMagentoImport(skuCount = 50) {
  console.log(`[DEBUG] generateMagentoImport() - Starting to generate Magento import for ${skuCount} SKUs`);
  
  const csvPath = path.join(__dirname, 'magento_image_and_description_report_table_2026-05-29T23_15_06.188861552Z.csv');
  
  if (!fs.existsSync(csvPath)) {
    throw new Error('Source CSV file not found in project root.');
  }

  // Load SKUs from the source CSV
  const skus = loadFirstSkusFromCsv(csvPath, skuCount);
  console.log(`[DEBUG] generateMagentoImport() - Loaded ${skus.length} SKUs from source CSV`);

  if (skus.length === 0) {
    throw new Error('No SKU values found in the provided CSV file.');
  }

  const magentoResults = [];
  let successCount = 0;
  let failureCount = 0;

  // Search for each SKU via the API
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    console.log(`[DEBUG] generateMagentoImport() - Processing SKU ${i + 1}/${skus.length}: ${sku}`);

    try {
      const searchResult = await searchSku(sku);

      if (searchResult.found && searchResult.products.length > 0) {
        // Use the first matching product
        const product = searchResult.products[0];
        
        // Create a synthetic API result format for conversion
        const apiResult = {
          title: product.title,
          raw: {
            sku: product.sku,
            z95xname: product.sku,
            shortz32xtitle: product.title,
            overview: product.description,
            primaryimage: product.image ? product.image.replace('https://www.milwaukeetool.com', '') : '',
            toolz32xwarranty: '',
            voltage: '',
            features: '',
            price: ''
          }
        };

        const magentoRow = convertToMagentoFormat(apiResult);
        magentoResults.push(magentoRow);
        successCount++;
        console.log(`[DEBUG] generateMagentoImport() - Matched: ${sku}`);
      } else {
        failureCount++;
        console.warn(`[DEBUG] generateMagentoImport() - No match found for SKU: ${sku}`);
      }
    } catch (error) {
      failureCount++;
      console.error(`[DEBUG] generateMagentoImport() - Error processing SKU ${sku}:`, error.message);
    }

    // Add a small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`[DEBUG] generateMagentoImport() - Completed. Success: ${successCount}, Failures: ${failureCount}`);

  const csvContent = magentoResultsToCsv(magentoResults);
  
  return {
    csvContent,
    successCount,
    failureCount,
    totalProcessed: skus.length,
    results: magentoResults
  };
}

module.exports = {
  scrapeSkuData,
  scrapeFirst50MagentoSkus,
  searchSku,
  fetchProductDetails,
  generateMagentoImport,
  loadFirstSkusFromCsv
};
