import decorate from '../accordion.js';

describe('Accordion Block', () => {
  let block;

  beforeEach(() => {
    // Create a mock accordion structure
    block = document.createElement('div');
    block.className = 'accordion';

    // Create accordion items
    const item1 = document.createElement('div');
    const label1 = document.createElement('div');
    label1.textContent = 'Item 1 Title';
    const body1 = document.createElement('div');
    body1.innerHTML = '<p>Item 1 Content</p>';

    item1.appendChild(label1);
    item1.appendChild(body1);
    block.appendChild(item1);

    // Create second item
    const item2 = document.createElement('div');
    const label2 = document.createElement('div');
    label2.textContent = 'Item 2 Title';
    const body2 = document.createElement('div');
    body2.innerHTML = '<p>Item 2 Content</p>';

    item2.appendChild(label2);
    item2.appendChild(body2);
    block.appendChild(item2);
  });

  describe('Structure', () => {
    it('should convert rows to details elements', () => {
      decorate(block);
      const details = block.querySelectorAll('details.accordion-item');
      expect(details.length).toBe(2);
    });

    it('should create summary elements with correct class', () => {
      decorate(block);
      const summaries = block.querySelectorAll('summary.accordion-item-label');
      expect(summaries.length).toBe(2);
    });

    it('should create body divs with correct class', () => {
      decorate(block);
      const bodies = block.querySelectorAll('div.accordion-item-body');
      expect(bodies.length).toBe(2);
    });

    it('should preserve content in summary', () => {
      decorate(block);
      const summaries = block.querySelectorAll('summary');
      expect(summaries[0].textContent).toBe('Item 1 Title');
      expect(summaries[1].textContent).toBe('Item 2 Title');
    });

    it('should preserve content in body', () => {
      decorate(block);
      const bodies = block.querySelectorAll('div.accordion-item-body');
      expect(bodies[0].innerHTML).toContain('Item 1 Content');
      expect(bodies[1].innerHTML).toContain('Item 2 Content');
    });
  });

  describe('Nesting', () => {
    it('should properly nest summary and body within details', () => {
      decorate(block);
      const detail = block.querySelector('details');
      const children = Array.from(detail.children);
      expect(children[0].tagName).toBe('SUMMARY');
      expect(children[1].classList.contains('accordion-item-body')).toBe(true);
    });

    it('should have correct parent-child relationship', () => {
      decorate(block);
      const summary = block.querySelector('summary');
      expect(summary.parentElement.classList.contains('accordion-item')).toBe(true);
    });
  });

  describe('Multiple Items', () => {
    it('should handle multiple accordion items independently', () => {
      decorate(block);
      const details = block.querySelectorAll('details');
      expect(details.length).toBe(2);

      // Each should have its own summary and body
      details.forEach((detail, index) => {
        const summary = detail.querySelector('summary');
        const body = detail.querySelector('.accordion-item-body');
        expect(summary).toBeDefined();
        expect(body).toBeDefined();
        expect(summary.textContent).toBe(`Item ${index + 1} Title`);
      });
    });
  });

  describe('Empty Items', () => {
    it('should handle empty accordion bodies', () => {
      block = document.createElement('div');
      const item = document.createElement('div');
      const label = document.createElement('div');
      label.textContent = 'Empty Item';
      const bodyElement = document.createElement('div');
      // No content in body
      item.appendChild(label);
      item.appendChild(bodyElement);
      block.appendChild(item);

      decorate(block);

      const details = block.querySelector('details');
      const body = details.querySelector('.accordion-item-body');
      expect(body.innerHTML).toBe('');
    });
  });

  describe('Complex Content', () => {
    it('should preserve HTML structure in body', () => {
      block = document.createElement('div');
      const item = document.createElement('div');
      const label = document.createElement('div');
      label.textContent = 'Complex';
      const body = document.createElement('div');
      body.innerHTML = `
        <h3>Heading</h3>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
      `;
      item.appendChild(label);
      item.appendChild(body);
      block.appendChild(item);

      decorate(block);

      const bodyElement = block.querySelector('.accordion-item-body');
      expect(bodyElement.querySelector('h3')).toBeDefined();
      expect(bodyElement.querySelectorAll('li').length).toBe(2);
    });
  });

  describe('Accessibility', () => {
    it('should use semantic HTML (details/summary)', () => {
      decorate(block);
      const details = block.querySelector('details');
      expect(details).toBeDefined();
      expect(details.querySelector('summary')).toBeDefined();
    });

    it('should have descriptive class names', () => {
      decorate(block);
      expect(block.querySelector('.accordion-item')).toBeDefined();
      expect(block.querySelector('.accordion-item-label')).toBeDefined();
      expect(block.querySelector('.accordion-item-body')).toBeDefined();
    });
  });
});
