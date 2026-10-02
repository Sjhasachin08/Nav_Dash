/* Import the non-API fields from the supplied Fund Watch workbook. */
const path = require('path');
const XLSX = require('xlsx');
const store = require('../services/staticFundDataStore');

const workbookPath = process.argv[2] || 'C:/Users/ss/Desktop/Data Centre/Report AS ON 18-Aug-2026.xlsx';
const workbook = XLSX.readFile(workbookPath);
const skip = new Set(['Home', 'Graph Data', 'NFOs', 'Disclaimer']);
const clean = value => String(value ?? '').trim();
const useful = value => clean(value) && clean(value) !== '--';
const normalizedLabel = value => clean(value).toLowerCase().replace(/\s+/g, ' ');
const riskLabels = new Map([
  ['std.dev', 'Std.Dev'],
  ['beta (slope)', 'Beta (Slope)'],
  ['sharpe', 'Sharpe'],
  ['jenson', 'Jenson']
]);
const marketLabels = new Map([
  ['large cap', 'Large Cap'],
  ['mid cap', 'Mid Cap'],
  ['small cap', 'Small Cap'],
  ['debt & others', 'Debt & Others'],
  ['cash', 'Cash'],
  ['cash and fixed deposits', 'Cash']
]);

let imported = 0;
for (const sheetName of workbook.SheetNames) {
  if (skip.has(sheetName)) continue;
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  const headingRow = rows.findIndex(row => row.some(cell => clean(cell).toLowerCase().includes('risk measures')));
  if (headingRow < 0) continue;
  const headings = rows[headingRow].map(clean);
  const subheadings = (rows[headingRow + 1] || []).map(clean);
  const indexOf = phrase => headings.findIndex(value => value.toLowerCase().includes(phrase));
  const riskIndex = indexOf('risk measures');
  const marketIndex = indexOf('market capitalisation');
  const sectorIndex = indexOf('amfi sectors');
  const exitIndex = indexOf('exit load');
  if ([riskIndex, marketIndex, sectorIndex, exitIndex].some(i => i < 0)) continue;

  for (const row of rows.slice(headingRow + 2)) {
    const schemeName = clean(row[0]);
    const exitLoad = clean(row[exitIndex]);
    if (!schemeName || /^(fund watch|as on|.+plan\s*)$/i.test(schemeName)) continue;

    const riskMeasures = {};
    for (let index = 0; index < subheadings.length; index++) {
      const label = riskLabels.get(normalizedLabel(subheadings[index]));
      if (label && useful(row[index])) riskMeasures[label] = row[index];
    }

    const marketCapitalisation = {};
    for (let index = 0; index < subheadings.length; index++) {
      const label = marketLabels.get(normalizedLabel(subheadings[index]));
      if (label && useful(row[index])) marketCapitalisation[label] = row[index];
    }

    const amfiSectors = [];
    for (let offset = 0; offset < 5; offset++) {
      if (useful(row[sectorIndex + offset])) amfiSectors.push(clean(row[sectorIndex + offset]));
    }
    const hasDetails = useful(exitLoad) || Object.keys(riskMeasures).length > 0 || Object.keys(marketCapitalisation).length > 0 || amfiSectors.length > 0;
    if (!hasDetails) continue;

    try {
      const existing = store.findExactBySchemeName(schemeName);
      store.save({
        schemeName,
        category: sheetName,
        riskMeasures,
        marketCapitalisation,
        amfiSectors,
        exitLoad,
        launchDate: useful(row[2]) ? row[2] : existing?.launchDate || '',
        source: 'Report AS ON 18-Aug-2026.xlsx'
      }, existing?.id);
      imported++;
    } catch (error) {
      console.warn(`Skipped ${schemeName}: ${error.message}`);
    }
  }
}
console.log(`Imported ${imported} static fund records into ${path.relative(process.cwd(), path.join(__dirname, '../../data/fund-static-data.sqlite'))}.`);
