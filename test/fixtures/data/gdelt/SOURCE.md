# GDELT synthetic fixtures

The GDELT connector tests construct privacy-safe synthetic JSON and single-file
ZIP payloads in memory. They reproduce the documented DOC 2.0 JSON shapes,
`lastupdate.txt` index lines, 15-minute filenames, and tab-separated column
counts without copying live provider records, article text, URLs, or user data.

Official references reviewed on 2026-08-31:

- https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
- https://blog.gdeltproject.org/doc-geo-2-0-api-updates-full-year-searching-and-more/
- https://blog.gdeltproject.org/doc-2-0-updates-1-5-year-searching-and-updated-mobile-interface/
- https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/
- https://data.gdeltproject.org/gdeltv2/lastupdate.txt
- https://data.gdeltproject.org/gdeltv2/masterfilelist.txt
- https://data.gdeltproject.org/documentation/GDELT-Event_Codebook-V2.0.pdf
- https://data.gdeltproject.org/documentation/GDELT-Global_Knowledge_Graph_Codebook-V2.1.pdf
