/* ============================================
   The Rainforall - Scroll Animations
   Intersection Observer for reveal-on-scroll
   ============================================ */

document.addEventListener('DOMContentLoaded', () => {
  if (!('IntersectionObserver' in window)) {
    // Fallback: make everything visible
    document.querySelectorAll('.fade-up, .fade-in, .slide-left, .slide-right, .stagger-children').forEach(el => {
      el.classList.add('visible');
    });
    return;
  }

  const animatedElements = document.querySelectorAll('.fade-up, .fade-in, .slide-left, .slide-right, .stagger-children');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.15,
    rootMargin: '0px 0px -50px 0px'
  });

  animatedElements.forEach(el => observer.observe(el));
});
