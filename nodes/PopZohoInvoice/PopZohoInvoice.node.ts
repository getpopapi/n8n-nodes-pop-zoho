import * as crypto from 'crypto';
import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	IHttpRequestOptions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { ZOHO_URLS, ZOHO_ORG_HEADER } from '../../credentials/ZohoInvoiceOAuth2Api.credentials';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PopOrderItem {
	description: string;
	quantity: string;
	unit_price: string;
	rate: string;
	item_code?: { type?: string; value?: string };
	unit?: string;
	discount_type?: string;
	discount_percent?: string;
	discount_amount?: string;
	total_price?: string;
	total_tax?: string;
}

interface PopPayload {
	data?: {
		invoice_body?: {
			general_data?: {
				doc_type?: string;
				date?: string;
				invoice_number?: string;
				currency?: string;
			};
		};
		transferee_client?: {
			personal_data?: {
				company_name?: string;
				first_name?: string;
				last_name?: string;
				email?: string;
				tax_id_vat?: { id_code?: string; country_id?: string };
				tax_id_code?: string;
			};
			place?: {
				address?: string;
				city?: string;
				zip_code?: string;
				province_id?: string;
				country_id?: string;
			};
		};
		purchase_order_data?: { id?: string };
		connected_invoice_data?: { id?: string; date?: string };
		payment_data?: { terms_payment?: string };
		order_items?: PopOrderItem[];
	};
}

interface ZohoTax {
	tax_id: string;
	tax_name: string;
	tax_percentage: number;
}

interface ZohoContact {
	contact_id: string;
	contact_name: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePopPayload(payload: PopPayload, itemIndex: number, context: IExecuteFunctions): void {
	const data = payload.data;

	if (!data) {
		throw new NodeOperationError(context.getNode(), 'Missing field: data', { itemIndex });
	}

	const general = data.invoice_body?.general_data;

	const required: Array<[unknown, string]> = [
		[general?.doc_type,  'data.invoice_body.general_data.doc_type'],
		[general?.date,      'data.invoice_body.general_data.date'],
		[general?.currency,  'data.invoice_body.general_data.currency'],
		[data.transferee_client?.personal_data, 'data.transferee_client.personal_data'],
		[data.order_items,   'data.order_items'],
	];

	for (const [value, path] of required) {
		if (value === undefined || value === null || value === '') {
			throw new NodeOperationError(context.getNode(), `Missing required field: ${path}`, { itemIndex });
		}
	}

	if (!Array.isArray(data.order_items) || data.order_items.length === 0) {
		throw new NodeOperationError(context.getNode(), 'data.order_items must be a non-empty array', { itemIndex });
	}

	const docType = general!.doc_type!;
	if (!['TD01', 'TD04'].includes(docType)) {
		throw new NodeOperationError(
			context.getNode(),
			`Unsupported doc_type: ${docType}. Accepted values: TD01 (invoice), TD04 (credit note).`,
			{ itemIndex },
		);
	}
}

// ---------------------------------------------------------------------------
// Zoho API helpers
// ---------------------------------------------------------------------------

async function zohoGet(
	context: IExecuteFunctions,
	apiBase: string,
	orgHeaderKey: string,
	orgId: string,
	path: string,
): Promise<IDataObject> {
	const separator = path.includes('?') ? '&' : '?';
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: `${apiBase}/${path}${separator}organization_id=${orgId}`,
		headers: { [orgHeaderKey]: orgId },
		json: true,
	};
	return context.helpers.requestWithAuthentication.call(context, 'zohoInvoiceOAuth2Api', options) as Promise<IDataObject>;
}

async function zohoPost(
	context: IExecuteFunctions,
	apiBase: string,
	orgHeaderKey: string,
	orgId: string,
	path: string,
	body: IDataObject,
): Promise<IDataObject> {
	const separator = path.includes('?') ? '&' : '?';
	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${apiBase}/${path}${separator}organization_id=${orgId}`,
		headers: { [orgHeaderKey]: orgId },
		body,
		json: true,
	};
	return context.helpers.requestWithAuthentication.call(context, 'zohoInvoiceOAuth2Api', options) as Promise<IDataObject>;
}

// ---------------------------------------------------------------------------
// HMAC signature verification
// ---------------------------------------------------------------------------

function verifyPopSignature(
	context: IExecuteFunctions,
	rawBody: string,
	headers: IDataObject,
	secret: string,
	itemIndex: number,
): void {
	const signatureHeader = (headers['x-pop-signature'] ?? headers['X-POP-Signature'] ?? '') as string;
	const timestampHeader = (headers['x-pop-timestamp'] ?? headers['X-POP-Timestamp'] ?? '') as string;

	if (!signatureHeader || !timestampHeader) {
		throw new NodeOperationError(
			context.getNode(),
			'Missing POP signature headers (X-POP-Signature, X-POP-Timestamp). Request rejected.',
			{ itemIndex },
		);
	}

	// Reject requests older than 5 minutes (replay protection)
	const ts = parseInt(timestampHeader, 10);
	const age = Math.abs(Date.now() / 1000 - ts);
	if (isNaN(ts) || age > 300) {
		throw new NodeOperationError(
			context.getNode(),
			`Request timestamp is invalid or too old (${Math.round(age)}s). Replay attack rejected.`,
			{ itemIndex },
		);
	}

	const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody + timestampHeader).digest('hex');

	// Constant-time comparison to prevent timing attacks
	const sigBuf      = Buffer.from(signatureHeader);
	const expectedBuf = Buffer.from(expected);
	const match =
		sigBuf.length === expectedBuf.length &&
		crypto.timingSafeEqual(sigBuf, expectedBuf);

	if (!match) {
		throw new NodeOperationError(
			context.getNode(),
			'Invalid POP signature. Request rejected.',
			{ itemIndex },
		);
	}
}

// ---------------------------------------------------------------------------
// RSA JWT verification (origin proof)
// ---------------------------------------------------------------------------

function verifyPopJwt(
	token: string | undefined,
	publicKeyPem: string,
	context: IExecuteFunctions,
	itemIndex: number,
): void {
	if (!token) {
		throw new NodeOperationError(
			context.getNode(),
			'Missing _pop_jwt in payload. Request must originate from POP API.',
			{ itemIndex },
		);
	}

	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new NodeOperationError(context.getNode(), 'Malformed _pop_jwt.', { itemIndex });
	}

	const [headerB64, payloadB64, sigB64] = parts;
	const signingInput = `${headerB64}.${payloadB64}`;

	// base64url → Buffer (replace url-safe chars, then decode as base64)
	const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

	const verifier = crypto.createVerify('RSA-SHA256');
	verifier.update(signingInput);

	let valid: boolean;
	try {
		valid = verifier.verify(publicKeyPem, fromB64url(sigB64));
	} catch {
		throw new NodeOperationError(
			context.getNode(),
			'POP JWT verification error. Check that the RSA Public Key is correctly set.',
			{ itemIndex },
		);
	}

	if (!valid) {
		throw new NodeOperationError(
			context.getNode(),
			'Invalid POP JWT signature. Request rejected.',
			{ itemIndex },
		);
	}

	let claims: { iss?: string; exp?: number; iat?: number };
	try {
		claims = JSON.parse(fromB64url(payloadB64).toString('utf8'));
	} catch {
		throw new NodeOperationError(context.getNode(), 'Cannot parse _pop_jwt claims.', { itemIndex });
	}

	if (claims.iss !== 'popapi.io') {
		throw new NodeOperationError(
			context.getNode(),
			`Invalid JWT issuer: "${claims.iss}". Expected "popapi.io".`,
			{ itemIndex },
		);
	}

	const nowSec = Math.floor(Date.now() / 1000);
	if (!claims.exp || claims.exp < nowSec) {
		throw new NodeOperationError(
			context.getNode(),
			'POP JWT has expired. Request rejected.',
			{ itemIndex },
		);
	}
}

// ---------------------------------------------------------------------------
// Tax resolution
// ---------------------------------------------------------------------------

async function buildTaxMap(
	context: IExecuteFunctions,
	apiBase: string,
	orgHeaderKey: string,
	orgId: string,
	product: string,
): Promise<Map<string, string>> {
	// Zoho Invoice uses /taxes; Zoho Books uses /settings/taxes
	const taxPath = product === 'books' ? 'settings/taxes' : 'taxes';
	const response = await zohoGet(context, apiBase, orgHeaderKey, orgId, taxPath);
	const taxes = (response.taxes ?? []) as ZohoTax[];
	const map = new Map<string, string>();

	for (const tax of taxes) {
		const key = parseFloat(String(tax.tax_percentage)).toFixed(2);
		map.set(key, tax.tax_id);
	}

	return map;
}

function resolveTaxId(
	context: IExecuteFunctions,
	taxMap: Map<string, string>,
	rateStr: string,
	itemIndex: number,
): string | null {
	const normalized = parseFloat(rateStr || '0').toFixed(2);

	if (normalized === '0.00') return null;

	const taxId = taxMap.get(normalized);
	if (!taxId) {
		throw new NodeOperationError(
			context.getNode(),
			`Tax rate ${normalized}% not found in Zoho. Configure it in Settings → Taxes.`,
			{ itemIndex },
		);
	}

	return taxId;
}

// ---------------------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------------------

const GCC_COUNTRIES = new Set(['SA', 'BH', 'KW', 'OM', 'QA']);

function deriveVatTreatment(countryId: string | undefined, vatCode: string | undefined): string | null {
	if (!countryId) return null;
	const country = countryId.toUpperCase();
	if (country === 'AE') {
		return vatCode ? 'vat_registered' : 'consumer';
	}
	if (GCC_COUNTRIES.has(country)) {
		return vatCode ? 'gcc_vat_registered' : null;
	}
	return null;
}

async function searchContacts(
	context: IExecuteFunctions,
	apiBase: string,
	orgHeaderKey: string,
	orgId: string,
	searchText: string,
): Promise<ZohoContact[]> {
	const response = await zohoGet(
		context,
		apiBase,
		orgHeaderKey,
		orgId,
		`contacts?search_text=${encodeURIComponent(searchText)}`,
	);
	return (response.contacts ?? []) as ZohoContact[];
}

async function resolveContact(
	context: IExecuteFunctions,
	apiBase: string,
	orgHeaderKey: string,
	orgId: string,
	payload: PopPayload,
	createIfMissing: boolean,
	matchStrategy: string,
	itemIndex: number,
): Promise<{ contactId: string; contactCreated: boolean }> {
	const personal = payload.data!.transferee_client!.personal_data!;
	const place    = payload.data!.transferee_client?.place;

	const vatCode     = personal.tax_id_vat?.id_code;
	const vatCountry  = personal.tax_id_vat?.country_id;
	const email       = personal.email;
	const isCompany   = !!personal.company_name;
	const contactName = isCompany
		? personal.company_name!
		: [personal.first_name, personal.last_name].filter(Boolean).join(' ');

	// 1. Search by VAT / TRN (only when strategy includes VAT lookup)
	if (matchStrategy === 'vat_email_name' && vatCode) {
		const results = await searchContacts(context, apiBase, orgHeaderKey, orgId, vatCode);
		if (results.length === 1) return { contactId: results[0].contact_id, contactCreated: false };
		if (results.length > 1) {
			throw new NodeOperationError(
				context.getNode(),
				`Multiple Zoho contacts found for VAT/TRN ${vatCode}. Resolve the duplicate manually.`,
				{ itemIndex },
			);
		}
	}

	// 2. Search by email
	if (email) {
		const results = await searchContacts(context, apiBase, orgHeaderKey, orgId, email);
		if (results.length === 1) return { contactId: results[0].contact_id, contactCreated: false };
		if (results.length > 1) {
			throw new NodeOperationError(
				context.getNode(),
				`Multiple Zoho contacts found for email ${email}. Resolve the duplicate manually.`,
				{ itemIndex },
			);
		}
	}

	// 3. Search by name
	if (contactName) {
		const results = await searchContacts(context, apiBase, orgHeaderKey, orgId, contactName);
		if (results.length === 1) return { contactId: results[0].contact_id, contactCreated: false };
		if (results.length > 1) {
			throw new NodeOperationError(
				context.getNode(),
				`Multiple Zoho contacts found for name "${contactName}". Provide VAT or email to disambiguate.`,
				{ itemIndex },
			);
		}
	}

	// 4. Not found
	if (!createIfMissing) {
		throw new NodeOperationError(
			context.getNode(),
			'Contact not found in Zoho. Set "Create contact if missing" to true to create it automatically.',
			{ itemIndex },
		);
	}

	// 5. Create contact
	const contactBody: IDataObject = {
		contact_name: contactName,
		contact_type: 'customer',
	};

	if (isCompany) {
		contactBody.company_name = personal.company_name!;
	}

	if (email) {
		contactBody.contact_persons = [{ email, is_primary_contact: true }];
	}

	if (place) {
		contactBody.billing_address = {
			address:      place.address ?? '',
			city:         place.city ?? '',
			zip:          place.zip_code ?? '',
			state:        place.province_id ?? '',
			country_code: place.country_id ?? '',
		};
	}

	const vatTreatment = deriveVatTreatment(vatCountry, vatCode);
	if (vatTreatment) {
		contactBody.vat_treatment = vatTreatment;
	}

	const created    = await zohoPost(context, apiBase, orgHeaderKey, orgId, 'contacts', contactBody);
	const newContact = created.contact as ZohoContact;

	if (!newContact?.contact_id) {
		throw new NodeOperationError(
			context.getNode(),
			'Contact creation failed: Zoho did not return a contact_id.',
			{ itemIndex },
		);
	}

	return { contactId: newContact.contact_id, contactCreated: true };
}

// ---------------------------------------------------------------------------
// Payment terms
// ---------------------------------------------------------------------------

function derivePaymentTermsDays(termsPayment: string | undefined, defaultDays: number): number | null {
	if (!termsPayment) return null;
	if (termsPayment === 'TP01' || termsPayment === 'TP03') return 0;
	if (termsPayment === 'TP02') return defaultDays;
	return null;
}

// ---------------------------------------------------------------------------
// Payload mapping
// ---------------------------------------------------------------------------

function buildLineItems(
	items: PopOrderItem[],
	taxMap: Map<string, string>,
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject[] {
	return items.map((item) => {
		const taxId = resolveTaxId(context, taxMap, item.rate, itemIndex);

		const lineItem: IDataObject = {
			name:     item.description,
			quantity: parseFloat(item.quantity),
			rate:     parseFloat(item.unit_price),
		};

		if (taxId) lineItem.tax_id = taxId;

		if (item.item_code?.value) lineItem.sku  = item.item_code.value;
		if (item.unit)             lineItem.unit = item.unit;

		const discountPct = parseFloat(item.discount_percent || '0');
		const discountAmt = parseFloat(item.discount_amount || '0');
		const unitPrice   = parseFloat(item.unit_price);

		if (discountPct > 0) {
			lineItem.discount      = discountPct;
			lineItem.discount_type = 'percentage';
		} else if (discountAmt > 0 && unitPrice > 0) {
			// Zoho line items only accept percentage — derive it from the absolute amount
			lineItem.discount      = Math.round((discountAmt / unitPrice) * 10000) / 100;
			lineItem.discount_type = 'percentage';
		}

		return lineItem;
	});
}

function buildZohoInvoiceBody(
	payload: PopPayload,
	contactId: string,
	taxMap: Map<string, string>,
	sendEmail: boolean,
	invoiceStatus: string,
	defaultPlaceOfSupply: string,
	defaultPaymentTermsDays: number,
	context: IExecuteFunctions,
	itemIndex: number,
): IDataObject {
	const general   = payload.data!.invoice_body!.general_data!;
	const lineItems = buildLineItems(payload.data!.order_items!, taxMap, context, itemIndex);

	const body: IDataObject = {
		customer_id:   contactId,
		date:          general.date,
		currency_code: general.currency,
		line_items:    lineItems,
		status:        invoiceStatus,
	};

	if (payload.data?.purchase_order_data?.id) {
		body.reference_number = payload.data.purchase_order_data.id;
	}

	const paymentTermsDays = derivePaymentTermsDays(
		payload.data?.payment_data?.terms_payment,
		defaultPaymentTermsDays,
	);
	if (paymentTermsDays !== null) {
		body.payment_terms = paymentTermsDays;
	}

	if (defaultPlaceOfSupply) {
		body.place_of_supply = defaultPlaceOfSupply;
	}

	if (sendEmail) {
		body.send_from_org_email_id = true;
	}

	return body;
}

// ---------------------------------------------------------------------------
// Node definition
// ---------------------------------------------------------------------------

export class PopZohoInvoice implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'POP → Zoho',
		name: 'popZohoInvoice',
		icon: 'file:pop-zoho-invoice.svg',
		group: ['transform'],
		version: 1,
		description: 'Connect POP Cloud API (v2) payloads to Zoho Invoice / Zoho Books',
		defaults: { name: 'POP → Zoho' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'zohoInvoiceOAuth2Api',
				required: false,
			},
		],
		properties: [
			{
				displayName: 'POP API URL',
				name: 'popApiUrl',
				type: 'string',
				default: 'https://popapi.io',
				description: 'Base URL of your POP API instance (no trailing slash)',
				placeholder: 'https://popapi.io',
			},
			{
				displayName: 'POP API License Key',
				name: 'popConnectorSecret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description: 'Your POP API license key. Used to verify the HMAC signature on every incoming request.',
				placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
			},
			{
				displayName: 'POP API RSA Public Key Name or ID',
				name: 'popPublicKey',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'fetchPopPublicKey',
					loadOptionsDependsOn: ['popApiUrl'],
				},
				default: '',
				description: 'Click the refresh button to fetch the RSA public key automatically from your POP API instance. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Dry Run (No Zoho Calls)',
				name: 'dryRun',
				type: 'boolean',
				default: false,
				description:
					'Whether to validate the POP payload and return the mapped Zoho body without making any API call. Use for testing mapping without Zoho credentials.',
			},
			{
				displayName: 'Contact Match Strategy',
				name: 'contactMatchStrategy',
				type: 'options',
				options: [
					{
						name: 'Email → Name',
						value: 'email_name',
						description: 'Skip VAT lookup — search by email, then name',
					},
					{
						name: 'VAT → Email → Name',
						value: 'vat_email_name',
						description: 'Search by VAT/TRN first, then email, then company/person name',
					},
				],
				default: 'vat_email_name',
				description: 'How to find an existing Zoho contact for the invoice customer',
			},
			{
				displayName: 'Create Contact If Missing',
				name: 'createContactIfMissing',
				type: 'boolean',
				default: true,
				description:
					'Whether to automatically create the contact in Zoho when no match is found',
			},
			{
				displayName: 'Invoice Status',
				name: 'invoiceStatus',
				type: 'options',
				options: [
					{ name: 'Draft', value: 'draft' },
					{ name: 'Sent',  value: 'sent' },
				],
				default: 'draft',
				description: 'Status to set on the created invoice in Zoho',
			},
			{
				displayName: 'Send Email to Customer',
				name: 'sendEmail',
				type: 'boolean',
				default: false,
				description: "Whether to trigger Zoho's built-in invoice email to the customer after creation",
			},
			{
				displayName: 'Place of Supply',
				name: 'placeOfSupply',
				type: 'options',
				options: [
					{ name: 'Abu Dhabi (AE-AZ)',         value: 'AE-AZ' },
					{ name: 'Ajman (AE-AJ)',             value: 'AE-AJ' },
					{ name: 'Dubai (AE-DU)',             value: 'AE-DU' },
					{ name: 'Fujairah (AE-FU)',          value: 'AE-FU' },
					{ name: 'Not Specified',             value: '' },
					{ name: 'Other (Enter Code)',        value: 'other' },
					{ name: 'Ras Al Khaimah (AE-RK)',    value: 'AE-RK' },
					{ name: 'Sharjah (AE-SH)',           value: 'AE-SH' },
					{ name: 'Umm Al Quwain (AE-UQ)',     value: 'AE-UQ' },
				],
				default: '',
				description: 'Place of supply for e-invoicing (e.g. UAE emirates). Leave as "Not specified" if not required.',
			},
			{
				displayName: 'Place of Supply Code',
				name: 'placeOfSupplyCustom',
				type: 'string',
				default: '',
				displayOptions: { show: { placeOfSupply: ['other'] } },
				placeholder: 'e.g. IN-KA',
				description: 'Enter the place of supply code manually',
			},
			{
				displayName: 'Deferred Payment Terms (Days)',
				name: 'defaultPaymentTermsDays',
				type: 'number',
				default: 30,
				description:
					'Number of days granted for payment when the payload specifies deferred payment (e.g. bank transfer net 30). Not applied for immediate payments.',
			},
		],
		usableAsTool: true,
	};

	methods = {
		loadOptions: {
			async fetchPopPublicKey(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const apiUrl = (this.getNodeParameter('popApiUrl') as string).replace(/\/$/, '');
				if (!apiUrl) return [];

				const response = await this.helpers.httpRequest({
					method: 'GET',
					url: `${apiUrl}/wp-json/api/v2/connector/pubkey`,
					json: true,
				});

				const publicKey = (response as IDataObject)?.public_key as string;
				if (!publicKey) return [];

				return [{ name: 'POP API Public Key (Auto-Fetched)', value: publicKey }];
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items      = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		try {

		const popSecret    = this.getNodeParameter('popConnectorSecret', 0) as string;
		const popPublicKey = this.getNodeParameter('popPublicKey', 0) as string;
		const dryRunParam      = this.getNodeParameter('dryRun', 0) as boolean;

		const matchStrategy           = this.getNodeParameter('contactMatchStrategy', 0) as string;
		const createIfMissing         = this.getNodeParameter('createContactIfMissing', 0) as boolean;
		const sendEmail               = this.getNodeParameter('sendEmail', 0) as boolean;
		const invoiceStatus           = this.getNodeParameter('invoiceStatus', 0) as string;
		const defaultPaymentTermsDays = this.getNodeParameter('defaultPaymentTermsDays', 0) as number;

		const placeOfSupplySelect  = this.getNodeParameter('placeOfSupply', 0) as string;
		const defaultPlaceOfSupply = placeOfSupplySelect === 'other'
			? (this.getNodeParameter('placeOfSupplyCustom', 0) as string).trim()
			: placeOfSupplySelect;

		// 1. Security verification — always mandatory, cannot be disabled.
		//    Two independent checks:
		//    - HMAC: proves the payload belongs to the customer's license key
		//    - RSA JWT: proves the request originated from POP API servers
		if (!popSecret) {
			throw new NodeOperationError(this.getNode(), 'POP API License Key is required.');
		}
		if (!popPublicKey) {
			throw new NodeOperationError(this.getNode(), 'POP API RSA Public Key is required.');
		}
		for (let i = 0; i < items.length; i++) {
			const raw        = items[i].json as IDataObject;
			const body       = (raw.body ?? raw) as IDataObject;
			const headers    = (raw.headers ?? {}) as IDataObject;
			const bodyForSig = JSON.stringify(raw.body ?? raw);
			verifyPopSignature(this, bodyForSig, headers, popSecret, i);
			verifyPopJwt(body['_pop_jwt'] as string | undefined, popPublicKey, this, i);
		}

		// 2. Determine if any item needs live Zoho calls
		//    _pop_dry_run in payload (set server-side by POP API) overrides the node parameter.
		//    This allows POP API to enforce sandbox→dry_run without the client being able to fake it
		//    (the field is covered by the HMAC signature).
		const itemModes = items.map((item) => {
			const raw        = item.json as IDataObject;
			const body       = (raw.body ?? raw) as IDataObject;
			const fromPayload = (body as IDataObject)['_pop_dry_run'];
			return fromPayload !== undefined ? Boolean(fromPayload) : dryRunParam;
		});

		const needsLive = itemModes.some((isDry) => !isDry);

		// 3. Init Zoho connection once if at least one item is live
		let taxMap:      Map<string, string> | undefined;
		let apiBase:     string | undefined;
		let orgHeaderKey: string | undefined;
		let orgId:       string | undefined;
		let product:     string | undefined;

		if (needsLive) {
			const credentials = await this.getCredentials('zohoInvoiceOAuth2Api');
			product      = (credentials.product as string) ?? 'invoice';
			const region = (credentials.region  as string) ?? 'eu';
			orgId        = credentials.organizationId as string;
			apiBase      = (ZOHO_URLS[product] ?? ZOHO_URLS.invoice)[region] ?? ZOHO_URLS.invoice.eu;
			orgHeaderKey = ZOHO_ORG_HEADER[product] ?? ZOHO_ORG_HEADER.invoice;

			if (!orgId) {
				throw new NodeOperationError(
					this.getNode(),
					'Organization ID is missing in credentials. Set it in Zoho → Settings → Organization Profile.',
				);
			}

			taxMap = await buildTaxMap(this, apiBase, orgHeaderKey, orgId, product);
		}

		// 4. Process each item
		for (let i = 0; i < items.length; i++) {
			try {
				const raw        = items[i].json as IDataObject;
				const popPayload = (raw.body ? raw.body : raw) as PopPayload;
				const isDryRun   = itemModes[i];

				validatePopPayload(popPayload, i, this);

				const docType  = popPayload.data!.invoice_body!.general_data!.doc_type!;
				const endpoint = docType === 'TD04' ? 'creditnotes' : 'invoices';

				if (isDryRun) {
					const dryTaxMap = new Map<string, string>();
					for (const item of popPayload.data?.order_items ?? []) {
						const normalized = parseFloat(item.rate || '0').toFixed(2);
						if (normalized !== '0.00') {
							dryTaxMap.set(normalized, `DRY_RUN_TAX_ID_${normalized}pct`);
						}
					}

					const zohoBody = buildZohoInvoiceBody(
						popPayload, 'DRY_RUN_CONTACT_ID', dryTaxMap,
						sendEmail, invoiceStatus, defaultPlaceOfSupply, defaultPaymentTermsDays, this, i,
					);

					if (docType === 'TD04') {
						const connectedId   = popPayload.data?.connected_invoice_data?.id;
						const connectedDate = popPayload.data?.connected_invoice_data?.date;
						if (connectedId)   zohoBody.reference_invoice_id   = connectedId;
						if (connectedDate) zohoBody.reference_invoice_date = connectedDate;
					}

					returnData.push({
						json: {
							success:       true,
							status_code:   200,
							message:       'Dry run: payload validated and mapped successfully. No Zoho API call was made.',
							dry_run:       true,
							zoho_endpoint: `POST /${endpoint}`,
							zoho_body:     zohoBody,
						},
						pairedItem: { item: i },
					});

				} else {
					const { contactId, contactCreated } = await resolveContact(
						this, apiBase!, orgHeaderKey!, orgId!, popPayload, createIfMissing, matchStrategy, i,
					);

					const zohoBody = buildZohoInvoiceBody(
						popPayload, contactId, taxMap!,
						sendEmail, invoiceStatus, defaultPlaceOfSupply, defaultPaymentTermsDays, this, i,
					);

					if (docType === 'TD04') {
						const connectedId   = popPayload.data?.connected_invoice_data?.id;
						const connectedDate = popPayload.data?.connected_invoice_data?.date;
						if (connectedId)   zohoBody.reference_invoice_id   = connectedId;
						if (connectedDate) zohoBody.reference_invoice_date = connectedDate;
					}

					const response = await zohoPost(this, apiBase!, orgHeaderKey!, orgId!, endpoint, zohoBody);
					const doc      = (response.invoice ?? response.creditnote ?? {}) as IDataObject;
					const docType2 = docType === 'TD04' ? 'creditnote' : 'invoice';

					returnData.push({
						json: {
							success:             true,
							status_code:         200,
							message:             `${docType2 === 'creditnote' ? 'Credit note' : 'Invoice'} created successfully in Zoho.`,
							zoho_product:        product,
							zoho_document_type:  docType2,
							zoho_invoice_id:     (doc.invoice_id     as string) || (doc.creditnote_id     as string) || null,
							zoho_invoice_number: (doc.invoice_number as string) || (doc.creditnote_number as string) || null,
							zoho_status:         doc.status ?? null,
							zoho_total:          doc.total != null ? Math.round((doc.total as number) * 100) / 100 : null,
							contact_id:          contactId,
							contact_created:     contactCreated,
						},
						pairedItem: { item: i },
					});
				}
			} catch (itemError: unknown) {
				if (this.continueOnFail()) {
					const message = itemError instanceof Error ? itemError.message : 'Unknown error.';
					returnData.push({
						json: { success: false, error_code: 'connector_error', message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw itemError;
			}
		}

		return [returnData];

		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : 'Unknown connector error.';
			let errorCode = 'connector_error';

			if (/signature|timestamp|jwt|JWT|issuer|expired/i.test(message)) {
				errorCode = 'auth_error';
			} else if (/Missing required field|Missing field|must be a non-empty/i.test(message)) {
				errorCode = 'validation_error';
			} else if (/Unsupported doc_type/i.test(message)) {
				errorCode = 'unsupported_doc_type';
			} else if (/Tax rate.*not found/i.test(message)) {
				errorCode = 'tax_not_found';
			} else if (/Multiple Zoho contacts/i.test(message)) {
				errorCode = 'contact_ambiguous';
			} else if (/Contact not found/i.test(message)) {
				errorCode = 'contact_not_found';
			} else if (/Contact creation failed/i.test(message)) {
				errorCode = 'contact_creation_failed';
			} else if (/Organization ID/i.test(message)) {
				errorCode = 'config_error';
			} else if (/License Key|Public Key/i.test(message)) {
				errorCode = 'config_error';
			}

			return [[{
				json: { success: false, error_code: errorCode, message },
				pairedItem: { item: 0 },
			}]];
		}
	}
}
