/* ============================================
   The Rainforall - Main JavaScript
   Navigation, smooth scroll, lazy loading
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {
  // ---- Navigation scroll effect ----
  const nav = document.getElementById('main-nav');
  let lastScrollY = 0;

  function handleNavScroll() {
    const scrollY = window.scrollY;
    if (scrollY > 80) {
      nav.classList.add('nav-scrolled');
    } else {
      nav.classList.remove('nav-scrolled');
    }
    lastScrollY = scrollY;
  }

  window.addEventListener('scroll', handleNavScroll, { passive: true });

  // ---- Smooth scroll for anchor links ----
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href');
      if (targetId === '#' || targetId === '#shopify-product') return;

      e.preventDefault();
      const target = document.querySelector(targetId);
      if (target) {
        const navHeight = nav.offsetHeight;
        const targetPosition = target.getBoundingClientRect().top + window.scrollY - navHeight;

        window.scrollTo({
          top: targetPosition,
          behavior: 'smooth'
        });

        // Close mobile menu if open
        const mobileMenuOpen = document.querySelector('[x-data]');
        if (mobileMenuOpen && mobileMenuOpen.__x) {
          mobileMenuOpen.__x.$data.mobileOpen = false;
        }
      }
    });
  });

  // ---- Lazy loading images ----
  if ('IntersectionObserver' in window) {
    const lazyImages = document.querySelectorAll('img[data-src]');
    const imageObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.src;
          if (img.dataset.srcset) {
            img.srcset = img.dataset.srcset;
          }
          img.removeAttribute('data-src');
          img.removeAttribute('data-srcset');
          imageObserver.unobserve(img);
        }
      });
    }, {
      rootMargin: '200px 0px'
    });

    lazyImages.forEach(img => imageObserver.observe(img));
  } else {
    // Fallback: load all images immediately
    document.querySelectorAll('img[data-src]').forEach(img => {
      img.src = img.dataset.src;
    });
  }

  // ---- Active nav link highlighting ----
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-link');

  function highlightNav() {
    const scrollY = window.scrollY + 100;

    sections.forEach(section => {
      const sectionTop = section.offsetTop - 100;
      const sectionHeight = section.offsetHeight;
      const sectionId = section.getAttribute('id');

      if (scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
        navLinks.forEach(link => {
          link.classList.remove('text-white');
          link.classList.add('text-gray-400');
          if (link.getAttribute('href') === '#' + sectionId) {
            link.classList.remove('text-gray-400');
            link.classList.add('text-white');
          }
        });
      }
    });
  }

  window.addEventListener('scroll', highlightNav, { passive: true });

  // ---- Video fallback ----
  const heroVideo = document.getElementById('hero-video');
  if (heroVideo) {
    heroVideo.play().catch(() => {
      // Autoplay blocked - show poster image instead
      heroVideo.style.display = 'none';
      const poster = document.getElementById('hero-poster');
      if (poster) poster.style.display = 'block';
    });
  }
});
