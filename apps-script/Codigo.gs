/**
 * Backend de datos de Papin. Un solo Web App, router por "accion".
 *
 * Movimientos de papa (bolsas / kilogramos por etapa):
 *   POST { "fecha": "09/03/2026", "variedad": "agata" }   // acepta también YYYY-MM-DD
 *
 * Órdenes de trabajo / aplicación de agroquímicos:
 *   POST { "accion": "ordenes" }
 *
 * Diagnóstico:
 *   POST { "accion": "hojas" }                       -> pestañas + headers del Sheet de movimientos
 *   POST { "accion": "ordenes_raw", "limite": 20 }   -> grid crudo del Sheet de órdenes
 */

// Subir esto en cada cambio. Viene en toda respuesta, para saber si el deploy está al día.
const VERSION = 'v3-ordenes';

const SHEET_ID = '1oa21CUhzfNtrnzkdO0vF42mD-YRmraVM';

// Cada hoja declara SUS nombres de columna. Los nombres se comparan normalizados
// (trim + minúscula), así que no hace falta replicar rarezas como "Variedad ".
const SHEETS_CONFIG = [
	{ hoja: 'De campo a Frío',          colFecha: 'Fecha', colVariedad: 'Variedad', colBolsas: 'Bolsas', colKg: 'Kgs.' },
	{ hoja: 'Env a Frio',               colFecha: 'Fecha', colVariedad: 'Variedad', colBolsas: 'Bolsas', colKg: 'Kgs.' },
	{ hoja: 'Ret Frio',                 colFecha: 'Fecha', colVariedad: 'Variedad', colBolsas: 'Bolsas', colKg: 'Kg'   },
	{ hoja: 'Entregas a clientes 2026', colFecha: 'Fecha', colVariedad: 'Variedad', colBolsas: 'Bolsas', colKg: 'Kgs.' },
	// Nombres reales resueltos con { "accion": "hojas" }: "Ingreso" va en singular y
	// la pestaña de Trevelin tiene doble espacio. buscarHoja() absorbe esas rarezas.
	{ hoja: 'Ingreso Tolvas Santa Ana', colFecha: 'Fecha', colVariedad: 'Variedad', colBolsas: 'Bolsas', colKg: 'Kgs'  },
	{ hoja: 'Ingreso Trevelin',         colFecha: 'Fecha', colVariedad: 'Variedad', colBolsas: 'Bolsas', colKg: 'Kgs'  }
];

function doPost(e) {
	try {
		const params = leerParametros(e);
		const accion = normalizarTexto(params.accion);

		if (accion === 'hojas') return jsonOutput(listarHojas());
		if (accion === 'ordenes') return jsonOutput(listarOrdenes());
		if (accion === 'ordenes_raw') return jsonOutput(ordenesCrudo(parseNumero(params.limite)));

		// Sin acción cae en la consulta de movimientos: no rompe lo que ya funcionaba.
		return jsonOutput(consultar(params.fecha, params.variedad, e));
	} catch (err) {
		return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
	}
}

// Alias por comodidad: permite probar desde el navegador con ?fecha=...&variedad=...
function doGet(e) {
	return doPost(e);
}

function consultar(fechaInput, variedadInput, e) {
	const fechaCruda = String(fechaInput || '').trim();
	const variedad = String(variedadInput || '').trim();

	if (!fechaCruda || !variedad) {
		return {
			ok: false,
			error: 'Parámetros requeridos: fecha (YYYY-MM-DD o DD/MM/YYYY) y variedad',
			recibido: { fecha: fechaCruda, variedad: variedad },
			debug: describirEntrada(e)
		};
	}

	const ss = SpreadsheetApp.openById(SHEET_ID);
	const tz = ss.getSpreadsheetTimeZone();

	// El input se normaliza con la MISMA función que las celdas, así los dos lados de
	// la comparación hablan el mismo idioma. Acepta 2026-05-18 y 18/05/2026 por igual.
	const fecha = normalizarFecha(fechaCruda, tz);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
		return { ok: false, error: 'Fecha no reconocida: "' + fechaCruda + '". Usar YYYY-MM-DD o DD/MM/YYYY' };
	}

	const variedadBuscada = normalizarTexto(variedad);

	const resultados = [];
	const hojasOmitidas = [];

	SHEETS_CONFIG.forEach(function (cfg) {
		const sheet = buscarHoja(ss, cfg.hoja);
		if (!sheet) {
			hojasOmitidas.push({ hoja: cfg.hoja, motivo: 'No existe una pestaña con ese nombre' });
			return;
		}

		const values = sheet.getDataRange().getValues();
		if (values.length < 2) {
			hojasOmitidas.push({ hoja: cfg.hoja, motivo: 'La hoja no tiene filas de datos' });
			return;
		}

		const headers = values[0];
		const idxFecha = buscarIndice(headers, cfg.colFecha);
		const idxVariedad = buscarIndice(headers, cfg.colVariedad);
		const idxBolsas = buscarIndice(headers, cfg.colBolsas);
		const idxKg = buscarIndice(headers, cfg.colKg);

		const faltantes = [];
		if (idxFecha === -1) faltantes.push(cfg.colFecha);
		if (idxVariedad === -1) faltantes.push(cfg.colVariedad);
		if (idxBolsas === -1) faltantes.push(cfg.colBolsas);
		if (idxKg === -1) faltantes.push(cfg.colKg);

		if (faltantes.length > 0) {
			hojasOmitidas.push({ hoja: cfg.hoja, motivo: 'Columnas no encontradas: ' + faltantes.join(', ') });
			return;
		}

		let bolsas = 0;
		let kilogramos = 0;
		let filas = 0;

		for (let i = 1; i < values.length; i++) {
			const row = values[i];
			if (normalizarFecha(row[idxFecha], tz) !== fecha) continue;
			if (normalizarTexto(row[idxVariedad]) !== variedadBuscada) continue;

			bolsas += parseNumero(row[idxBolsas]);
			kilogramos += parseNumero(row[idxKg]);
			filas++;
		}

		resultados.push({
			hoja: cfg.hoja,
			bolsas: redondear(bolsas),
			kilogramos: redondear(kilogramos),
			filas: filas
		});
	});

	return {
		ok: true,
		fecha: fecha,
		variedad: variedad,
		resultados: resultados,
		hojasOmitidas: hojasOmitidas
	};
}

// --- Diagnóstico -----------------------------------------------------------

function listarHojas() {
	const ss = SpreadsheetApp.openById(SHEET_ID);
	return {
		ok: true,
		hojas: ss.getSheets().map(function (s) {
			const values = s.getDataRange().getValues();
			return {
				nombre: s.getName(),
				headers: values.length > 0 ? values[0] : [],
				filas: Math.max(0, values.length - 1),
				filasMuestra: values.slice(1, 3)
			};
		})
	};
}

// --- Helpers ---------------------------------------------------------------

/**
 * Los clientes entregan los parámetros de formas muy distintas: body JSON plano,
 * body JSON envuelto en {body:...}/{data:...}, form-encoded, o un JSON como string
 * dentro de un campo del form. Se prueban todas antes de darse por vencido.
 */
function leerParametros(e) {
	if (e && e.postData && e.postData.contents) {
		const body = parseJsonSeguro(e.postData.contents);
		if (body) {
			const desenvuelto = desenvolver(body);
			if (tieneParametros(desenvuelto)) return desenvuelto;
		}
	}

	// Form-encoded o query params. Un campo puede traer el JSON como string.
	if (e && e.parameter) {
		if (tieneParametros(e.parameter)) return e.parameter;

		const claves = Object.keys(e.parameter);
		for (let i = 0; i < claves.length; i++) {
			const anidado = parseJsonSeguro(e.parameter[claves[i]]);
			if (anidado) {
				const desenvuelto = desenvolver(anidado);
				if (tieneParametros(desenvuelto)) return desenvuelto;
			}
		}
		return e.parameter;
	}

	return {};
}

function parseJsonSeguro(texto) {
	if (typeof texto !== 'string' || !texto) return null;
	try {
		const v = JSON.parse(texto);
		return (v && typeof v === 'object') ? v : null;
	} catch (err) {
		return null;
	}
}

// Desarma envoltorios comunes: { body: {...} }, { data: {...} }, { arguments: {...} }.
function desenvolver(obj) {
	const envoltorios = ['body', 'data', 'params', 'parameters', 'arguments', 'input', 'payload'];
	for (let i = 0; i < envoltorios.length; i++) {
		const interno = obj[envoltorios[i]];
		if (interno && typeof interno === 'object') return interno;
		const parseado = parseJsonSeguro(interno);
		if (parseado) return parseado;
	}
	return obj;
}

function tieneParametros(obj) {
	if (!obj || typeof obj !== 'object') return false;
	return !!(obj.fecha || obj.variedad || obj.accion);
}

/**
 * Cuando no llegan los parámetros, devolver qué SÍ llegó. Sin esto, un cliente mal
 * configurado y un pedido vacío legítimo son indistinguibles.
 */
function describirEntrada(e) {
	if (!e) return 'sin objeto de evento';
	const partes = [];
	partes.push('parameter=' + JSON.stringify(e.parameter || {}));
	if (e.postData) {
		partes.push('postDataType=' + e.postData.type);
		partes.push('postDataContents=' + String(e.postData.contents || '').substring(0, 200));
	} else {
		partes.push('postData=ausente');
	}
	return partes.join(' | ');
}

function normalizarTexto(valor) {
	return String(valor == null ? '' : valor).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * getSheetByName es match exacto, y los nombres de pestaña traen rarezas
 * ("Ingreso  Trevelin" con doble espacio). Si el exacto falla, reintenta normalizado.
 */
function buscarHoja(ss, nombreHoja) {
	const exacta = ss.getSheetByName(nombreHoja);
	if (exacta) return exacta;

	const objetivo = normalizarTexto(nombreHoja);
	const hojas = ss.getSheets();
	for (let i = 0; i < hojas.length; i++) {
		if (normalizarTexto(hojas[i].getName()) === objetivo) return hojas[i];
	}
	return null;
}

function buscarIndice(headers, nombreColumna) {
	const objetivo = normalizarTexto(nombreColumna);
	for (let i = 0; i < headers.length; i++) {
		if (normalizarTexto(headers[i]) === objetivo) return i;
	}
	return -1;
}

function normalizarFecha(valor, tz) {
	if (valor instanceof Date) {
		return Utilities.formatDate(valor, tz, 'yyyy-MM-dd');
	}

	const texto = String(valor == null ? '' : valor).trim();
	if (!texto) return '';

	// Ya viene como YYYY-MM-DD (con o sin hora pegada).
	if (/^\d{4}-\d{2}-\d{2}/.test(texto)) return texto.substring(0, 10);

	// dd/mm/yyyy o dd-mm-yyyy — el formato en que se escriben las fechas en la operación.
	const m = texto.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
	if (m) {
		let dia = parseInt(m[1], 10);
		let mes = parseInt(m[2], 10);

		// Si el primero no puede ser un día pero el segundo sí, vino en mm/dd/yyyy.
		if (mes > 12 && dia <= 12) {
			const tmp = dia;
			dia = mes;
			mes = tmp;
		}
		if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return texto;

		const anio = m[3].length === 2 ? '20' + m[3] : m[3];
		return anio + '-' + pad2(mes) + '-' + pad2(dia);
	}

	return texto;
}

function pad2(n) {
	return n < 10 ? '0' + n : String(n);
}

/**
 * Extrae un número de una celda que puede venir sucia: "29080 kg", "49,87 kg", "29.080".
 * Convenciones es-AR: coma = decimal; punto seguido de exactamente 3 dígitos = miles.
 */
function parseNumero(valor) {
	if (typeof valor === 'number') return isNaN(valor) ? 0 : valor;

	let limpio = String(valor == null ? '' : valor).replace(/[^\d,.\-]/g, '');
	if (!limpio) return 0;

	const tieneComa = limpio.indexOf(',') !== -1;
	const tienePunto = limpio.indexOf('.') !== -1;

	if (tieneComa && tienePunto) {
		limpio = limpio.replace(/\./g, '').replace(',', '.'); // 29.080,50 -> 29080.50
	} else if (tieneComa) {
		limpio = limpio.replace(',', '.');                    // 49,87 -> 49.87
	} else if (tienePunto && /\.\d{3}$/.test(limpio)) {
		limpio = limpio.replace(/\./g, '');                   // 29.080 -> 29080
	}

	const n = parseFloat(limpio);
	return isNaN(n) ? 0 : n;
}

function redondear(n) {
	return Math.round(n * 100) / 100;
}

function jsonOutput(obj) {
	if (obj && typeof obj === 'object') obj.version = VERSION;
	return ContentService
		.createTextOutput(JSON.stringify(obj))
		.setMimeType(ContentService.MimeType.JSON);
}

// ============ Órdenes de trabajo / aplicación ============

const ORDENES_SHEET_ID = '1h1q9zz2obXFBI2yApY3cidb6GgNKXHzguboXlo0u0_4';
const ORDENES_HOJA = 'Hoja 1';

// Etiquetas que marcan cada fila de cabecera. Se comparan normalizadas y por prefijo,
// porque la planilla usa celdas combinadas y las posiciones de columna se corren.
const ORD_BLOQUE = 'orden de trabajo';
const ORD_FECHA_TAREA = 'fecha tarea';
const ORD_APLICADOR = 'aplicador';

function listarOrdenes() {
	const ss = SpreadsheetApp.openById(ORDENES_SHEET_ID);
	const tz = ss.getSpreadsheetTimeZone();
	const sheet = buscarHoja(ss, ORDENES_HOJA);

	if (!sheet) {
		return {
			ok: false,
			error: 'No existe la hoja "' + ORDENES_HOJA + '" en el spreadsheet de órdenes',
			hojasDisponibles: ss.getSheets().map(function (s) { return s.getName(); })
		};
	}

	const values = sheet.getDataRange().getValues();
	const ordenes = [];
	const avisos = [];

	for (let i = 0; i < values.length; i++) {
		if (indiceQueEmpieza(values[i], ORD_BLOQUE) === -1) continue;

		const bloque = leerBloqueOrden(values, i, tz);
		if (bloque.orden) ordenes.push(bloque.orden);
		if (bloque.aviso) avisos.push(bloque.aviso);
		i = bloque.ultimaFila; // saltar lo ya consumido
	}

	return {
		ok: true,
		hoja: sheet.getName(),
		total: ordenes.length,
		ordenes: ordenes,
		avisos: avisos
	};
}

function leerBloqueOrden(values, inicio, tz) {
	const filaBloque = values[inicio];
	const idxLabel = indiceQueEmpieza(filaBloque, ORD_BLOQUE);

	// El número y la fecha están a la derecha de la etiqueta, en columnas que varían
	// según cómo quedaron las celdas combinadas. Se toma el primer valor de cada tipo.
	const numero = primerNumero(filaBloque, idxLabel + 1);
	const fecha = primerFecha(filaBloque, idxLabel + 1, tz);

	let fechaTarea = '';
	let hora = '';
	let aplicador = '';
	let idxHeaders = -1;

	// Las cabeceras están justo abajo, pero se buscan por contenido para tolerar
	// filas de más o de menos entre bloques.
	const limite = Math.min(values.length, inicio + 8);
	for (let j = inicio + 1; j < limite; j++) {
		const fila = values[j];
		if (indiceQueEmpieza(fila, ORD_BLOQUE) !== -1) break;

		const idxFT = indiceQueEmpieza(fila, ORD_FECHA_TAREA);
		if (idxFT !== -1) {
			fechaTarea = primerFecha(fila, idxFT + 1, tz);
			hora = primerHora(fila, idxFT + 1, tz);
			continue;
		}

		const idxAp = indiceQueEmpieza(fila, ORD_APLICADOR);
		if (idxAp !== -1) {
			// "Ubicación" es un encabezado agrupador en esta misma fila, no el aplicador.
			aplicador = primerTexto(fila, idxAp + 1, ['ubicación', 'ubicacion']);
			continue;
		}

		if (buscarIndice(fila, 'Marca') !== -1 || buscarIndice(fila, 'Dosis/ha') !== -1) {
			idxHeaders = j;
			break;
		}
	}

	if (idxHeaders === -1) {
		return {
			orden: null,
			aviso: {
				fila: inicio + 1,
				numero: numero,
				motivo: 'No se encontró la fila de encabezados de productos (Marca / Dosis/ha)'
			},
			ultimaFila: inicio
		};
	}

	const headers = values[idxHeaders];
	const col = {
		marca: buscarIndice(headers, 'Marca'),
		agroquimico: buscarIndice(headers, 'AGROQUÍMICOS'),
		dosis: buscarIndice(headers, 'Dosis/ha'),
		pivote: buscarIndice(headers, 'Pivote'),
		tercio: buscarIndice(headers, 'Tercio'),
		superficie: buscarIndice(headers, 'Superficie'),
		totalUso: buscarIndice(headers, 'Total Uso'),
		herramienta: buscarIndice(headers, 'Herramienta'),
		observaciones: buscarIndice(headers, 'Observaciones')
	};

	const productos = [];
	let fin = idxHeaders;

	for (let k = idxHeaders + 1; k < values.length; k++) {
		const fila = values[k];
		if (indiceQueEmpieza(fila, ORD_BLOQUE) !== -1) break;
		if (filaVacia(fila)) break;

		const marca = celdaTexto(fila, col.marca);
		const agroquimico = celdaTexto(fila, col.agroquimico);

		// Marca vacía es válido (a veces solo se anota el activo). El corte real es
		// que no haya NI marca NI agroquímico.
		if (!marca && !agroquimico) break;

		productos.push({
			marca: marca,
			agroquimico: agroquimico,
			dosisHa: celdaNumero(fila, col.dosis),
			pivote: celdaTexto(fila, col.pivote),
			tercio: celdaTexto(fila, col.tercio),
			superficie: celdaNumero(fila, col.superficie),
			totalUso: celdaNumero(fila, col.totalUso),
			herramienta: celdaTexto(fila, col.herramienta),
			observaciones: celdaTexto(fila, col.observaciones)
		});
		fin = k;
	}

	return {
		orden: {
			numero: numero,
			fecha: fecha,
			fechaTarea: fechaTarea,
			hora: hora,
			aplicador: aplicador,
			productos: productos
		},
		aviso: productos.length === 0
			? { fila: inicio + 1, numero: numero, motivo: 'Bloque sin filas de productos' }
			: null,
		ultimaFila: fin
	};
}

// --- Diagnóstico: volcado crudo, para no adivinar el layout ---

function ordenesCrudo(limite) {
	const ss = SpreadsheetApp.openById(ORDENES_SHEET_ID);
	const sheet = buscarHoja(ss, ORDENES_HOJA);

	if (!sheet) {
		return {
			ok: false,
			error: 'No existe la hoja "' + ORDENES_HOJA + '"',
			hojasDisponibles: ss.getSheets().map(function (s) { return s.getName(); })
		};
	}

	const values = sheet.getDataRange().getValues();
	const n = limite > 0 ? limite : 40;
	return {
		ok: true,
		hoja: sheet.getName(),
		filasTotales: values.length,
		hojasDisponibles: ss.getSheets().map(function (s) { return s.getName(); }),
		filas: values.slice(0, n)
	};
}

// --- Helpers de lectura posicional tolerante ---

// Primera celda cuyo texto normalizado EMPIECE con lo buscado.
function indiceQueEmpieza(fila, textoBuscado) {
	for (let i = 0; i < fila.length; i++) {
		if (normalizarTexto(fila[i]).indexOf(textoBuscado) === 0) return i;
	}
	return -1;
}

function primerNumero(fila, desde) {
	for (let i = desde; i < fila.length; i++) {
		if (typeof fila[i] === 'number') return fila[i];
		const t = String(fila[i] == null ? '' : fila[i]).trim();
		if (/^\d+$/.test(t)) return parseInt(t, 10);
	}
	return null;
}

function primerFecha(fila, desde, tz) {
	for (let i = desde; i < fila.length; i++) {
		const v = fila[i];
		if (v instanceof Date) {
			// Una celda de solo hora también es Date, con año centinela 1899.
			if (v.getFullYear() > 1900) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
			continue;
		}
		const f = normalizarFecha(v, tz);
		if (/^\d{4}-\d{2}-\d{2}$/.test(f)) return f;
	}
	return '';
}

function primerHora(fila, desde, tz) {
	for (let i = desde; i < fila.length; i++) {
		const v = fila[i];
		if (v instanceof Date) {
			const hhmm = Utilities.formatDate(v, tz, 'HH:mm');
			// Solo-hora (año centinela), o un datetime cuya hora no sea medianoche.
			if (v.getFullYear() <= 1900 || hhmm !== '00:00') return hhmm;
			continue;
		}
		const t = String(v == null ? '' : v).trim();
		if (/^\d{1,2}:\d{2}/.test(t)) return t;
	}
	return '';
}

function primerTexto(fila, desde, excluir) {
	for (let i = desde; i < fila.length; i++) {
		const t = String(fila[i] == null ? '' : fila[i]).trim();
		if (!t) continue;
		if (excluir && excluir.indexOf(normalizarTexto(t)) !== -1) continue;
		return t;
	}
	return '';
}

function filaVacia(fila) {
	for (let i = 0; i < fila.length; i++) {
		if (String(fila[i] == null ? '' : fila[i]).trim() !== '') return false;
	}
	return true;
}

function celdaTexto(fila, idx) {
	if (idx === -1 || idx >= fila.length) return '';
	return String(fila[idx] == null ? '' : fila[idx]).trim();
}

function celdaNumero(fila, idx) {
	if (idx === -1 || idx >= fila.length) return 0;
	return parseNumero(fila[idx]);
}
