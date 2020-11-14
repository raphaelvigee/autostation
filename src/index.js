const puppeteer = require('puppeteer');
const fs = require('fs');
const FormData = require('form-data');
const fetch = require('node-fetch');

function sayTxt(things) {
  if (things.length <= 1) {
    return `say '${things[0]}'`;
  }

  return `say one of ${things.map((t) => `'${t}'`).join(', ')}`;
}

async function resetDetails(context) {
  context.setState({ details: {}, askingForDetails: false });
}

const fields = {
  firstname: 'First Name',
  lastname: 'Last Name',
  birthday: 'Birthday (DD/MM/YYYY)',
  placeofbirth: 'Place of Birth',
  address: 'Address',
  city: 'City',
  zipcode: 'Postal Code',
};

function isValidDetails(context) {
  const { details } = context.state;

  if (!details) {
    return false;
  }

  for (const [field] of Object.entries(fields)) {
    if (!details[field]) {
      return false;
    }
  }

  return true;
}

async function handleFill(context) {
  const txt = context.event.text;

  if (txt.toLowerCase() === 'cancel') {
    await context.sendText(`Alrighty`);
    await resetDetails(context);
    context.setState({ askingForDetails: false });
    return;
  }

  if (context.state.askingForDetails) {
    context.setState({
      details: {
        ...context.state.details,
        [context.state.askingForDetails]: txt,
      },
    });
  }

  const { details } = context.state;

  for (const [field, fieldName] of Object.entries(fields)) {
    if (!details[field]) {
      if (!context.state.askingForDetails) {
        await context.sendText(
          `I'm going to ask some things from you, say cancel to... cancel`
        );
      }

      context.setState({
        askingForDetails: field,
      });
      await context.sendText(`What is your ${fieldName}?`);
      return;
    }
  }

  context.setState({
    askingForDetails: false,
  });
  await context.sendText(`All set!`);
}

const browserPromise = puppeteer.launch({
  // headless: false,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

function pad(n) {
  return `${n}`.padStart(2, '0');
}

async function generate(context, reason) {
  await context.sendText(`Working on it, hang tight...`);

  const browser = await browserPromise;
  const page = await browser.newPage();

  const now = new Date();

  const folderId = `${context.session.id}_${now.getMilliseconds()}`;
  const downloadFolder = `./downloads/${folderId}`;

  try {
    fs.mkdirSync(downloadFolder, { recursive: true });

    await page.goto('https://media.interieur.gouv.fr/deplacement-covid-19/', {
      waitUntil: 'networkidle2',
    });

    await page._client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadFolder,
    });

    page
      .on('console', (message) =>
        console.log(
          `${message.type().substr(0, 3).toUpperCase()}`,
          message.text()
        )
      )
      .on('pageerror', ({ message }) => console.log(message))
      .on('response', (response) =>
        console.log(`${response.status()} ${response.url()}`)
      )
      .on('requestfailed', (request) =>
        console.log(`${request.failure().errorText} ${request.url()}`)
      );

    // Fill form
    await page.type('#field-firstname', context.state.details.firstname);
    await page.type('#field-lastname', context.state.details.lastname);
    await page.type('#field-birthday', context.state.details.birthday);
    await page.type('#field-placeofbirth', context.state.details.placeofbirth);
    await page.type('#field-address', context.state.details.address);
    await page.type('#field-city', context.state.details.city);
    await page.type('#field-zipcode', context.state.details.zipcode);

    // Ew fix for timezone... no i cant be bothered to fix it properly
    let hours = now.getHours() + 1;
    let date = now.getDate();
    if (hours > 23) {
      hours = hours - 23;
      date++;
    }

    await page.evaluate((s) => {
      // eslint-disable-next-line no-undef
      document.querySelector('#field-datesortie').value = s;
    }, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(date)}`);
    await page.evaluate((s) => {
      // eslint-disable-next-line no-undef
      document.querySelector('#field-heuresortie').value = s;
    }, `${pad(hours)}:${pad(now.getMinutes())}`);

    await page.click(`input[type='checkbox'][value='${reason}']`);
    await page.click('#generate-btn');

    await page.waitForTimeout(1000);

    const files = fs.readdirSync(downloadFolder);

    const attFile = files[0];
    const attPath = `${downloadFolder}/${attFile}`;

    if (attFile) {
      switch (context.platform) {
        case 'messenger':
          await context.sendFile(fs.createReadStream(attPath));
          break;
        case 'telegram': {
          const url = `https://api.telegram.org/bot${process.env.TELEGRAM_ACCESS_TOKEN}/sendDocument`;

          let f = new FormData();
          f.append('chat_id', context._getChatId());
          f.append('document', fs.createReadStream(attPath));

          await fetch(url, {
            method: 'POST',
            body: f,
          });
          break;
        }
        case 'console':
          fs.copyFileSync(attPath, '/tmp/attestation.pdf');
          break;
      }
    } else {
      await context.sendText(`Hum something went wrong... try again!`);
    }
  } catch (e) {
    console.error(e);
    await context.sendText(`Hum something went really wrong... try again!`);
  } finally {
    fs.rmdirSync(downloadFolder, { recursive: true });

    await page.close();
  }
}

const hiTriggers = ['hi', 'hello'];
const resetTriggers = ['reset', 'forget'];
const fillTriggers = ['fill'];
const derogationTriggers = ['please', 'gimme', 'derogation'];

async function handleHi(context) {
  await context.sendText(`Hi!`);
  await help(context);
}

const reasonTxtToReason = {
  travail: 'travail',
  achats: 'achats',
  sante: 'sante',
  famille: 'famille',
  handicap: 'handicap',
  sport_animaux: 'sport_animaux',
  sport: 'sport_animaux',
  animaux: 'sport_animaux',
  convocation: 'convocation',
  missions: 'missions',
  enfants: 'enfants',
};
const validReasonsArray = Object.keys(reasonTxtToReason);
const validReasons = validReasonsArray.join(', ');

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

async function handleDerogation(context) {
  if (!isValidDetails(context)) {
    await context.sendText(
      `Looks like I am missing some details from you, ${sayTxt(
        fillTriggers
      )} to complete them`
    );

    return;
  }

  const reasonTxt = normalize(context.event.text).split(' ').slice(1).join(' ');
  if (!reasonTxt) {
    await context.sendText(
      `You need to call this followed by the reason, example: ${context.firstWord} ${validReasonsArray[0]}`
    );
    await context.sendText(`Possible reasons are: ${validReasons}`);
    return;
  }

  const reason = reasonTxtToReason[reasonTxt];
  if (!reason) {
    await context.sendText(
      `This does not seems like a valid reasons. Possible reasons are: ${validReasons}`
    );
    return;
  }

  await generate(context, reason);
}

async function help(context) {
  await context.sendText(
    `For a derogation, ${sayTxt(
      derogationTriggers
    )} followed by one of the following reason:\n${validReasons}`
  );
  await context.sendText(
    `To make me forget everything I know about you, ${sayTxt(resetTriggers)}`
  );
  await context.sendText(`Otherwise, ${sayTxt(hiTriggers)}`);
}

async function handleWtf(context) {
  await context.sendText(`Hum, not sure I understand`);
  await help(context);
}

async function handleReset(context) {
  await context.sendText(`Alrighty, forgetting everything about you`);
  await resetDetails(context);
}

module.exports = async function App(context) {
  if (context.event.isText) {
    const firstWord = context.event.text.split(' ')[0];
    context.firstWord = firstWord;
    const txt = normalize(firstWord);

    if (context.state.askingForDetails) {
      return handleFill(context);
    }

    if (hiTriggers.includes(txt)) {
      return handleHi(context);
    } else if (fillTriggers.includes(txt)) {
      return handleFill(context);
    } else if (derogationTriggers.includes(txt)) {
      return handleDerogation(context);
    } else if (resetTriggers.includes(txt)) {
      return handleReset(context);
    }
  }

  return handleWtf(context);
};
