const address = 'https://source.zloader.de';
const button = document.querySelector('#copy');
const input = document.querySelector('#source-url');
const status = document.querySelector('#copy-status');
button.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(address);
    button.textContent = 'Kopiert';
    status.textContent = 'Source-Adresse kopiert.';
  } catch {
    input.value = address;
    input.focus();
    input.select();
    button.textContent = 'Kopieren';
    status.textContent = 'Bitte die markierte Adresse manuell kopieren.';
  }
});
