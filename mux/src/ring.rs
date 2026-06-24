use std::collections::VecDeque;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring {
            buf: VecDeque::new(),
            cap: cap.max(1),
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            return;
        }
        self.buf.extend(data);
        if self.buf.len() > self.cap {
            let overflow = self.buf.len() - self.cap;
            self.buf.drain(..overflow);
        }
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_under_the_cap() {
        let mut r = Ring::new(10);
        r.push(b"abc");
        r.push(b"def");
        assert_eq!(r.snapshot(), b"abcdef");
    }

    #[test]
    fn evicts_oldest_bytes_past_the_cap() {
        let mut r = Ring::new(4);
        r.push(b"abcd");
        r.push(b"ef");
        assert_eq!(r.snapshot(), b"cdef");
    }

    #[test]
    fn push_larger_than_cap_keeps_the_tail() {
        let mut r = Ring::new(3);
        r.push(b"abcdefg");
        assert_eq!(r.snapshot(), b"efg");
    }

    #[test]
    fn starts_empty() {
        let r = Ring::new(8);
        assert!(r.is_empty());
        assert_eq!(r.len(), 0);
    }
}
