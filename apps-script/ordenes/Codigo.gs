function doGet() {
  const sheet = SpreadsheetApp.openById('1h1q9zz2obXFBI2yApY3cidb6GgNKXHzguboXlo0u0_4').getSheetByName('Hoja 1');
  const rows = sheet.getDataRange().getDisplayValues();
  const headers = rows[0];

  const data = [];
  for (let i = 1; i < rows.length; i++) {
    if (!String(rows[i][0]).trim()) continue; // saltea vacías y las notas al pie
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      if (String(headers[j]).trim()) obj[String(headers[j]).trim()] = rows[i][j];
    }
    data.push(obj);
  }

  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
