import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export const ZOHO_URLS: Record<string, Record<string, string>> = {
	invoice: {
		com:      'https://www.zohoapis.com/invoice/v3',
		eu:       'https://www.zohoapis.eu/invoice/v3',
		in:       'https://www.zohoapis.in/invoice/v3',
		'com.au': 'https://www.zohoapis.com.au/invoice/v3',
		jp:       'https://www.zohoapis.jp/invoice/v3',
		ca:       'https://www.zohoapis.ca/invoice/v3',
	},
	books: {
		com:      'https://www.zohoapis.com/books/v3',
		eu:       'https://www.zohoapis.eu/books/v3',
		in:       'https://www.zohoapis.in/books/v3',
		'com.au': 'https://www.zohoapis.com.au/books/v3',
		jp:       'https://www.zohoapis.jp/books/v3',
		ca:       'https://www.zohoapis.ca/books/v3',
	},
};

export const ZOHO_ORG_HEADER: Record<string, string> = {
	invoice: 'X-com-zoho-invoice-organizationid',
	books:   'X-com-zoho-books-organizationid',
};

const SCOPE_STRING_INVOICE = 'ZohoInvoice.invoices.CREATE,ZohoInvoice.invoices.READ,ZohoInvoice.creditnotes.CREATE,ZohoInvoice.creditnotes.READ,ZohoInvoice.contacts.CREATE,ZohoInvoice.contacts.READ,ZohoInvoice.settings.READ';
const SCOPE_STRING_BOOKS   = 'ZohoBooks.invoices.CREATE,ZohoBooks.invoices.READ,ZohoBooks.creditnotes.CREATE,ZohoBooks.creditnotes.READ,ZohoBooks.contacts.CREATE,ZohoBooks.contacts.READ,ZohoBooks.settings.READ';

const REGION_OAUTH: Record<string, { auth: string; token: string }> = {
	com: {
		auth:  'https://accounts.zoho.com/oauth/v2/auth',
		token: 'https://accounts.zoho.com/oauth/v2/token',
	},
	eu: {
		auth:  'https://accounts.zoho.eu/oauth/v2/auth',
		token: 'https://accounts.zoho.eu/oauth/v2/token',
	},
	in: {
		auth:  'https://accounts.zoho.in/oauth/v2/auth',
		token: 'https://accounts.zoho.in/oauth/v2/token',
	},
	'com.au': {
		auth:  'https://accounts.zoho.com.au/oauth/v2/auth',
		token: 'https://accounts.zoho.com.au/oauth/v2/token',
	},
	jp: {
		auth:  'https://accounts.zoho.jp/oauth/v2/auth',
		token: 'https://accounts.zoho.jp/oauth/v2/token',
	},
	ca: {
		auth:  'https://accounts.zohocloud.ca/oauth/v2/auth',
		token: 'https://accounts.zohocloud.ca/oauth/v2/token',
	},
};

export class ZohoInvoiceOAuth2Api implements ICredentialType {
	name = 'zohoInvoiceOAuth2Api';
	displayName = 'Zoho Invoice OAuth2 API';
	icon = 'file:pop-zoho-invoice.svg' as const;
	documentationUrl = 'https://www.zoho.com/invoice/api/v3/';
	extends = ['oAuth2Api'];

	properties: INodeProperties[] = [
		{
			displayName: 'Product',
			name: 'product',
			type: 'options',
			options: [
				{ name: 'Zoho Invoice', value: 'invoice' },
				{ name: 'Zoho Books',   value: 'books' },
			],
			default: 'invoice',
			description: 'Zoho product to connect to. Use Zoho Books for UAE e-invoicing.',
		},
		{
			displayName: 'Region',
			name: 'region',
			type: 'options',
			options: [
				{ name: 'Europe',        value: 'eu' },
				{ name: 'United States', value: 'com' },
				{ name: 'India',         value: 'in' },
				{ name: 'Australia',     value: 'com.au' },
				{ name: 'Japan',         value: 'jp' },
				{ name: 'Canada',        value: 'ca' },
			],
			default: 'eu',
			description: 'Data center region of your Zoho account',
		},
		{
			displayName: 'Organization ID',
			name: 'organizationId',
			type: 'string',
			default: '',
			required: true,
			description: 'Found in Zoho → Settings → Organization Profile',
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'string',
			default: REGION_OAUTH.eu.auth,
			required: true,
			description:
				'Set based on your region — EU: accounts.zoho.eu | US: accounts.zoho.com | IN: accounts.zoho.in | AU: accounts.zoho.com.au | JP: accounts.zoho.jp | CA: accounts.zohocloud.ca',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'string',
			default: REGION_OAUTH.eu.token,
			required: true,
			description: 'Same host as Authorization URL, path: /oauth/v2/token',
		},

		{
			displayName: 'Scope',
			name: 'scope',
			type: 'string',
			default: SCOPE_STRING_INVOICE,
			displayOptions: { show: { product: ['invoice'] } },
			description:
				'OAuth2 scopes requested from Zoho Invoice. The pre-filled value includes all scopes required for full connector operation (invoices, credit notes, contacts, settings). Edit only if you know what you are doing.',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'string',
			default: SCOPE_STRING_BOOKS,
			displayOptions: { show: { product: ['books'] } },
			description:
				'OAuth2 scopes requested from Zoho Books. The pre-filled value includes all scopes required for full connector operation (invoices, credit notes, contacts, settings). Edit only if you know what you are doing.',
		},

		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'string',
			default: 'access_type=offline',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'body',
		},
	];
}
