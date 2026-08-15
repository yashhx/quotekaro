const header = document.querySelector('.site-header');
const menuButton = document.querySelector('[data-menu-button]');
const tradeMenus = document.querySelectorAll('[data-trade-menu]');

menuButton?.addEventListener('click', () => {
  const open = header.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});

tradeMenus.forEach((menu) => {
  const trigger = menu.querySelector('button');
  trigger?.addEventListener('click', (event) => {
    event.stopPropagation();
    tradeMenus.forEach((other) => { if (other !== menu) other.classList.remove('open'); });
    const open = menu.classList.toggle('open');
    trigger.setAttribute('aria-expanded', String(open));
  });
});

document.addEventListener('click', () => tradeMenus.forEach((menu) => menu.classList.remove('open')));

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => { if (entry.isIntersecting) entry.target.classList.add('is-in'); });
}, { threshold: .12 });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

const page = document.body.dataset.page;
document.querySelectorAll('[data-page-link]').forEach((link) => {
  if (link.dataset.pageLink === page) link.classList.add('active');
});
