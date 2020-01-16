const {
  BaseKonnector,
  requestFactory,
  signin,
  saveBills,
  log,
  utils
} = require('cozy-konnector-libs')
const qs = require('querystring')

const j = requestFactory().jar()
const requestHtml = requestFactory({
  debug: true,
  cheerio: true,
  followAllRedirects: true,
  json: false,
  jar: j,
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0',
  }
})

// Pour accéder à l'espace client Total Direct Energie le User-Agent doit être défini et il ne doit pas changer tout au
// long de la session. Le User-Agent de requestJson doit donc être le même que le celui de requestHtml sinon les
// requêtes de requestJson ne passent pas.
// La redéfinition du User-Agent de requestHtml quand cheerio est actif ne fonctionne pas et cheerio le définit à
// Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0
// Donc on le redéfinit à cette valeur dans requestJson.
// Voir https://github.com/konnectors/libs/issues/442.
const requestJson = requestFactory({
  debug: true,
  cheerio: false,
  json: true,
  jar: j,
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0',
  }
})

const requestPdf = requestFactory({
  debug: true,
  cheerio: false,
  json: false,
  jar: j,
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0',
  }
})

const VENDOR = 'total-direct-energie'
const baseUrl = 'https://clients-total.direct-energie.com'
const authenticateUrl = `${baseUrl}/connexion-clients-professionnels`;
const invoicesUrl = `${baseUrl}/grandcompte/factures/suivi-par-site`;
const downloadUrl = `${baseUrl}/grandcompte/factures/consulter-votre-facture`;

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of documents')
  const info = await requestJson({
    method: 'POST',
    uri: `${invoicesUrl}/?` + qs.encode({
      'type': 1516639100,
      'tx_degcecfluid_pi1[action]': 'ajaxGetFactures',
      'tx_degcecfluid_pi1[controller]': 'EcGc',
    })
  })
  const docs = await requestJson({
    method: 'POST',
    uri: `${invoicesUrl}/?` + qs.encode({
      'type': 1516639100,
      'tx_degcecfluid_pi1[action]': 'ajaxGetFactures',
      'tx_degcecfluid_pi1[controller]': 'EcGc',
    }),
    form: { start: 0, length: info.recordsFiltered }
  })
  log('info', docs)

  log('info', 'Parsing list of documents')
  let documents = docs.data.map(doc => ({
    vendor: VENDOR,
    date: new Date(doc.VIFL_INTEGRATION_DATE.replace(/^([0-3][0-9])\/([01][0-9])\/(?:20)?([0-9]{2})$/, '$2/$1/$3')),
    amount: new Number(doc.VIFL_MONTANT_TTC),
    currency: 'EUR',
    fileurl: `${downloadUrl}/?` + qs.encode({
      'tx_defacturation[docId]': doc.facture.docId,
      'cHash': doc.facture.cacheHash
    }),
    vendorRef: doc.VIFL_UNIQ_ID,
    contractId: doc.VIFL_PAR_ID,
    metadata: {
      // It can be interesting to add the date of import. This is not mandatory but may be
      // useful for debugging or data migration
      importDate: new Date(),
      // Document version, useful for migration after change of document structure
      version: 1
    }
  }))
  log('info', documents)
  documents = documents.map(doc => ({
    ...doc,
    filename: `${utils.formatDate(doc.date)}_${VENDOR}_${doc.amount.toFixed(
      2
    )}EUR${doc.vendorRef ? '_' + doc.vendorRef : ''}.pdf`,

  }))

  log('info', documents)

  // Here we use the saveBills function even if what we fetch are not bills,
  // but this is the most common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(documents, fields, {
    identifiers: ['total direct energie'],
    requestInstance: requestPdf,
    contentType: 'application/pdf',
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
}

function authenticate(username, password) {
  return signin({
    requestInstance: requestHtml,
    url: authenticateUrl,
    formSelector: 'form:has(input#tx_deauthentification_login)',
    formData: {
      'tx_deauthentification[form_valid]': '1',
      'tx_deauthentification[redirect_url]': '',
      'tx_deauthentification[mdp_oublie]': 'Je+me+connecte',
      'tx_deauthentification[login]': username,
      'tx_deauthentification[password]': password
    },
    validate: (statusCode, $, fullResponse) => {
      log(
        'debug',
        fullResponse.request.uri.href,
        'not used here but should be useful for other connectors'
      )
      // The login in toscrape.com always works except when no password is set
      if ($('a.ec_deconnexion').length > 0) {
        return true
      } else {
        // cozy-konnector-libs has its own logging function which format these logs with colors in
        // standalone and dev mode and as JSON in production mode
        log('error', $('html').text())
        return false
      }
    }
  })
}
